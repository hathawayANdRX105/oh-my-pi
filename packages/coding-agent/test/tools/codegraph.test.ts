/**
 * Contract tests for the built-in `codegraph` tool: the `codegraph.enabled`
 * tri-state gate, the in-process read actions over a fixture index (row
 * format, exact target resolution, traversal depth, path filters, schema
 * guard), and `sync` — the only action that spawns the `codegraph` CLI.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as piUtils from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import * as execModule from "../../src/exec/exec";
import type { ToolSession } from "../../src/tools";
import { CodegraphTool, findCodegraphIndexRoot, isCodegraphEnabled } from "../../src/tools/codegraph";
import { resolveBuiltinToolPlan } from "../../src/tools/index";

/** One `nodes` row plus the FTS text backing its search hit. */
interface FixtureNode {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	filePath: string | null;
	startLine: number | null;
	signature?: string;
	docstring?: string;
	isExported?: boolean;
}

/**
 * Fixture graph pinning the traversal contracts. Call edges: `outer → mid →
 * alpha ⇄ beta` — the mutual pair is the cycle `impact` must terminate on, and
 * the chain makes depth 1 vs 2 observably different. `lonely` has no edges at
 * all while `beta`'s docstring matches the query text "lonely", so a resolver
 * that fell back to the search top-hit instead of the exact symbol would
 * surface alpha as lonely's caller. Import edges chain `tests/a.test.ts →
 * src/a.ts → src/b.ts` for the affected-breadth walk.
 */
const FIXTURE_NODES: FixtureNode[] = [
	{ id: "file:src/a.ts", kind: "file", name: "a.ts", qualifiedName: "src/a.ts", filePath: "src/a.ts", startLine: 1 },
	{
		id: "function:alpha",
		kind: "function",
		name: "alpha",
		qualifiedName: "src.alpha",
		filePath: "src/a.ts",
		startLine: 10,
		signature: "function alpha(): void",
		docstring: "Applies the alpha transform.",
		isExported: true,
	},
	{ id: "file:src/b.ts", kind: "file", name: "b.ts", qualifiedName: "src/b.ts", filePath: "src/b.ts", startLine: 1 },
	{
		id: "function:beta",
		kind: "function",
		name: "beta",
		qualifiedName: "src.beta",
		filePath: "src/b.ts",
		startLine: 20,
		signature: "function beta(): void",
		docstring: "Fallback when the lonely path is taken.",
		isExported: true,
	},
	{
		id: "function:gamma",
		kind: "function",
		name: "gamma",
		qualifiedName: "src.gamma",
		filePath: "src/b.ts",
		startLine: 30,
		signature: "function gamma(\n\tvalue: number\n): number",
		isExported: true,
	},
	{
		id: "function:lonely",
		kind: "function",
		name: "lonely",
		qualifiedName: "src.lonely",
		filePath: "src/b.ts",
		startLine: 40,
		signature: "function lonely(): void",
	},
	{
		id: "function:mid",
		kind: "function",
		name: "mid",
		qualifiedName: "app.mid",
		filePath: "src/mid.ts",
		startLine: 5,
		signature: "function mid(): void",
	},
	{
		id: "function:outer",
		kind: "function",
		name: "outer",
		qualifiedName: "app.outer",
		filePath: "src/outer.ts",
		startLine: 5,
		signature: "function outer(): void",
	},
	{
		id: "file:tests/a.test.ts",
		kind: "file",
		name: "a.test.ts",
		qualifiedName: "tests/a.test.ts",
		filePath: "tests/a.test.ts",
		startLine: 1,
	},
	{
		id: "file:golden/expected.ts",
		kind: "file",
		name: "expected.ts",
		qualifiedName: "golden/expected.ts",
		filePath: "golden/expected.ts",
		startLine: 1,
	},
	{
		id: "file:srcfoo/a.ts",
		kind: "file",
		name: "a.ts",
		qualifiedName: "srcfoo/a.ts",
		filePath: "srcfoo/a.ts",
		startLine: 1,
	},
];

/** `source → target` = caller → callee for relation edges; import edges point dependent → dependency. */
const FIXTURE_EDGES: ReadonlyArray<{ source: string; target: string; kind: string }> = [
	{ source: "function:outer", target: "function:mid", kind: "calls" },
	{ source: "function:mid", target: "function:alpha", kind: "calls" },
	{ source: "function:alpha", target: "function:beta", kind: "calls" },
	{ source: "function:beta", target: "function:alpha", kind: "calls" },
	{ source: "file:src/a.ts", target: "file:src/b.ts", kind: "imports" },
	{ source: "file:tests/a.test.ts", target: "file:src/a.ts", kind: "imports" },
];

const FIXTURE_FILES = [
	"src/a.ts",
	"src/b.ts",
	"src/mid.ts",
	"src/outer.ts",
	"srcfoo/a.ts",
	"tests/a.test.ts",
	"golden/expected.ts",
] as const;

/** Build a readable fixture index; `schemaVersion` drives the schema-guard path. */
async function createFixtureIndex(root: string, schemaVersion: number): Promise<void> {
	const dbDir = path.join(root, ".codegraph");
	fs.mkdirSync(dbDir, { recursive: true });
	const db = new Database(path.join(dbDir, "codegraph.db"), { create: true });
	try {
		db.run("CREATE TABLE schema_versions (version INTEGER NOT NULL)");
		db.run("INSERT INTO schema_versions (version) VALUES (?)", [schemaVersion]);
		db.run(
			`CREATE TABLE nodes (
	id TEXT NOT NULL PRIMARY KEY,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	qualified_name TEXT,
	file_path TEXT,
	start_line INTEGER,
	signature TEXT,
	docstring TEXT,
	is_exported INTEGER NOT NULL DEFAULT 0
)`,
		);
		db.run("CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, name, qualified_name, docstring, signature)");
		db.run("CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL)");
		db.run("CREATE TABLE files (path TEXT NOT NULL PRIMARY KEY, language TEXT, content_hash TEXT)");
		for (const node of FIXTURE_NODES) {
			db.run(
				"INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line, signature, docstring, is_exported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[
					node.id,
					node.kind,
					node.name,
					node.qualifiedName,
					node.filePath,
					node.startLine,
					node.signature ?? null,
					node.docstring ?? null,
					node.isExported === true ? 1 : 0,
				],
			);
			db.run("INSERT INTO nodes_fts (id, name, qualified_name, docstring, signature) VALUES (?, ?, ?, ?, ?)", [
				node.id,
				node.name,
				node.qualifiedName,
				node.docstring ?? "",
				node.signature ?? "",
			]);
		}
		for (const edge of FIXTURE_EDGES) {
			db.run("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)", [edge.source, edge.target, edge.kind]);
		}
		for (const filePath of FIXTURE_FILES) {
			db.run("INSERT INTO files (path, language, content_hash) VALUES (?, ?, ?)", [
				filePath,
				"typescript",
				"fixture",
			]);
		}
	} finally {
		db.close();
	}
}

function createSession(cwd: string, settings?: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		skipPythonPreflight: true,
		settings: settings ?? Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

const tempDirs: Array<{ path(): string; remove(): Promise<void> }> = [];

async function makeTempDir(prefix: string): Promise<string> {
	const temp = await piUtils.TempDir.create(prefix);
	tempDirs.push(temp);
	return temp.path();
}

/** Index root with a v4 fixture; a cwd nested below it; no-index and stale-schema roots. */
let fixtureRoot = "";
let packageCwd = "";
let plainRoot = "";
let staleRoot = "";

beforeAll(async () => {
	fixtureRoot = await makeTempDir("@omp-codegraph-fixture-");
	plainRoot = await makeTempDir("@omp-codegraph-plain-");
	staleRoot = await makeTempDir("@omp-codegraph-stale-");
	await createFixtureIndex(fixtureRoot, 4);
	await createFixtureIndex(staleRoot, 3);
	packageCwd = path.join(fixtureRoot, "packages", "pkg");
	fs.mkdirSync(packageCwd, { recursive: true });
});

afterAll(async () => {
	for (const temp of tempDirs) await temp.remove();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("codegraph gate", () => {
	test("off disables the tool even when an index exists", async () => {
		const session = createSession(fixtureRoot, Settings.isolated({ "codegraph.enabled": "off" }));
		expect(isCodegraphEnabled(session)).toBe(false);
		const plan = await resolveBuiltinToolPlan(session, ["codegraph"]);
		expect(plan.isAllowed("codegraph")).toBe(false);
		expect(plan.names).not.toContain("codegraph");
	});

	test("on enables the tool with no index and reports setup guidance instead of a silent miss", async () => {
		const session = createSession(plainRoot, Settings.isolated({ "codegraph.enabled": "on" }));
		expect(isCodegraphEnabled(session)).toBe(true);
		await expect(new CodegraphTool(session).execute("cg-gate-on", { action: "status" })).rejects.toThrow(
			"No .codegraph index found above",
		);
	});

	test("auto enables only when an index exists at or above the cwd", () => {
		expect(findCodegraphIndexRoot(packageCwd)).toBe(fixtureRoot);
		expect(findCodegraphIndexRoot(plainRoot)).toBeNull();
		expect(isCodegraphEnabled(createSession(packageCwd))).toBe(true);
		expect(isCodegraphEnabled(createSession(plainRoot))).toBe(false);
	});
});

describe("codegraph queries", () => {
	test("query renders one row per hit as kind, qualified name, location, and signature", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-query", {
			action: "query",
			symbol: "alpha",
		});
		expect(textOf(result)).toBe("function src.alpha — src/a.ts:10 · function alpha(): void");
		expect(result.useless).toBeUndefined();
	});

	test("query folds a multi-line signature into its single result row", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-query-sig", {
			action: "query",
			symbol: "gamma",
		});
		expect(textOf(result)).toBe("function src.gamma — src/b.ts:30 · function gamma( value: number ): number");
	});

	test("query kind filter keeps only rows of the requested node kind", async () => {
		const tool = new CodegraphTool(createSession(fixtureRoot));
		const asFunction = await tool.execute("cg-kind-hit", { action: "query", symbol: "alpha", kind: "function" });
		expect(textOf(asFunction)).toBe("function src.alpha — src/a.ts:10 · function alpha(): void");

		const asFile = await tool.execute("cg-kind-miss", { action: "query", symbol: "alpha", kind: "file" });
		expect(textOf(asFile)).toBe(
			'No matches for "alpha". Try a shorter prefix, or action: "files" to browse indexed paths.',
		);
		expect(asFile.useless).toBe(true);
	});

	test("query clamps a limit past the action ceiling and says so", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-limit", {
			action: "query",
			symbol: "alpha",
			limit: 500,
		});
		expect(textOf(result)).toContain("Requested limit 500 clamped to the max of 100.");
	});

	test("callers resolves the exact symbol and lists every caller", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-callers", {
			action: "callers",
			symbol: "alpha",
		});
		const text = textOf(result);
		expect(text).toContain("Callers of function src.alpha — src/a.ts:10:");
		expect(text).toContain("function app.mid — src/mid.ts:5");
		expect(text).toContain("function src.beta — src/b.ts:20");
	});

	test("callers of an exact target with no edges reports none instead of answering for another match", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-callers-lonely", {
			action: "callers",
			symbol: "lonely",
		});
		const text = textOf(result);
		expect(text).toContain("Callers of function src.lonely — src/b.ts:40 — none.");
		// beta also matches the query text and does have callers; the exact
		// target wins, so beta's caller must never leak into this answer.
		expect(text).not.toContain("function src.alpha");
		expect(result.useless).toBe(true);
	});

	test("callees lists what the resolved symbol calls", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-callees", {
			action: "callees",
			symbol: "alpha",
		});
		const text = textOf(result);
		expect(text).toContain("Callees of function src.alpha — src/a.ts:10:");
		expect(text).toContain("function src.beta — src/b.ts:20");
		expect(text).not.toContain("function app.mid");
	});

	test("impact stops at the requested depth and stays bounded on a call cycle", async () => {
		const tool = new CodegraphTool(createSession(fixtureRoot));
		const shallow = await tool.execute("cg-impact-1", { action: "impact", symbol: "alpha", depth: 1 });
		const shallowLines = textOf(shallow).split("\n");
		expect(shallowLines[0]).toBe("Impact of function src.alpha — src/a.ts:10 (depth 1):");
		expect(shallowLines).toHaveLength(4); // header + alpha, beta, mid; outer is two hops out
		expect(textOf(shallow)).not.toContain("function app.outer");

		const deep = await tool.execute("cg-impact-2", { action: "impact", symbol: "alpha", depth: 2 });
		expect(textOf(deep)).toContain("function app.outer — src/outer.ts:5");

		// alpha ⇄ beta is a cycle: a deep walk must return the same bounded set.
		const bounded = await tool.execute("cg-impact-10", { action: "impact", symbol: "alpha", depth: 10 });
		const boundedLines = textOf(bounded).split("\n");
		expect(boundedLines[0]).toContain("(depth 10)");
		expect(boundedLines).toHaveLength(5); // header + alpha, beta, mid, outer — no cycle growth
	});

	test("affected reports tests only within the requested depth", async () => {
		const tool = new CodegraphTool(createSession(fixtureRoot));
		const shallow = await tool.execute("cg-affected-1", { action: "affected", files: ["src/b.ts"], depth: 1 });
		expect(textOf(shallow)).toContain("Test files affected by 1 changed file (depth 1, 1 dependents walked): none.");
		expect(shallow.useless).toBe(true);

		const deep = await tool.execute("cg-affected-2", { action: "affected", files: ["src/b.ts"], depth: 2 });
		expect(textOf(deep)).toContain("Test files affected by 1 changed file (depth 2, 2 dependents walked):");
		expect(textOf(deep)).toContain("tests/a.test.ts");
		expect(deep.useless).toBeUndefined();
	});

	test("affected seeds a changed test file itself", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-affected-seed", {
			action: "affected",
			files: ["tests/a.test.ts"],
		});
		expect(textOf(result)).toContain("tests/a.test.ts");
		expect(result.useless).toBeUndefined();
	});

	test("affected testFilter replaces the default test patterns wholesale", async () => {
		const tool = new CodegraphTool(createSession(fixtureRoot));
		const defaults = await tool.execute("cg-affected-default", {
			action: "affected",
			files: ["golden/expected.ts"],
		});
		expect(textOf(defaults)).toContain(": none."); // golden/ matches no default pattern
		expect(defaults.useless).toBe(true);

		const filtered = await tool.execute("cg-affected-filter", {
			action: "affected",
			files: ["golden/expected.ts"],
			testFilter: "golden/**",
		});
		expect(textOf(filtered)).toContain("golden/expected.ts");
		expect(filtered.useless).toBeUndefined();
	});

	test("files respects directory boundaries rather than raw prefixes", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-files-dir", {
			action: "files",
			dir: "src",
			format: "flat",
		});
		expect(textOf(result)).toBe("src/a.ts\nsrc/b.ts\nsrc/mid.ts\nsrc/outer.ts");
		expect(result.useless).toBeUndefined();
	});

	test("files defaults to a grouped listing with bare names under directory headers", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-files-grouped", {
			action: "files",
			dir: "src",
		});
		const text = textOf(result);
		expect(text).toContain("# src/");
		expect(text).not.toContain("src/a.ts"); // grouped folds the prefix into the header
	});

	test("files echoes its filters when nothing matches", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-files-empty", {
			action: "files",
			dir: "does/not/exist",
		});
		expect(textOf(result)).toBe('No indexed files matching dir "does/not/exist".');
		expect(result.useless).toBe(true);
	});

	test("files truncates at the requested limit and advertises the next step", async () => {
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute("cg-files-limit", {
			action: "files",
			format: "flat",
			limit: 2,
		});
		const lines = textOf(result).split("\n");
		expect(lines[0]).toBe("golden/expected.ts");
		expect(lines[1]).toBe("src/a.ts");
		expect(lines[2]).toBe("");
		expect(lines[3]).toBe("5 more indexed paths — raise `limit` or narrow `dir`/`pattern`.");
		expect(result.details?.meta?.limits?.resultLimit).toEqual({ reached: 2, suggestion: 4 });
	});

	test("status reports counts, journal mode, and skips pending changes outside git", async () => {
		// Nested cwd: status must also find the index by walking up from here.
		const result = await new CodegraphTool(createSession(packageCwd)).execute("cg-status", { action: "status" });
		const text = textOf(result);
		expect(text).toContain(path.join(fixtureRoot, ".codegraph", "codegraph.db"));
		expect(text).toContain("(journal delete)");
		expect(text).toContain(
			`${FIXTURE_FILES.length} files · ${FIXTURE_NODES.length} nodes · ${FIXTURE_EDGES.length} edges · DB `,
		);
		expect(text).toContain("Pending changes: skipped (not a git checkout).");
		expect(text).not.toContain("⚠");
		expect(result.useless).toBeUndefined();
	});

	test("reads reject an index whose schema version this build cannot read", async () => {
		await expect(
			new CodegraphTool(createSession(staleRoot)).execute("cg-stale", { action: "status" }),
		).rejects.toThrow("Codegraph index schema is v3 but this build reads v4");
	});

	test("read actions require their primary input", async () => {
		const tool = new CodegraphTool(createSession(fixtureRoot));
		await expect(tool.execute("cg-req-symbol", { action: "query" })).rejects.toThrow(
			'`symbol` is required for action "query"',
		);
		await expect(tool.execute("cg-req-files", { action: "affected" })).rejects.toThrow(
			'`files` is required for action "affected"',
		);
	});

	test("read actions never spawn the codegraph CLI", async () => {
		const execSpy = vi.spyOn(execModule, "execCommand");
		const tool = new CodegraphTool(createSession(fixtureRoot));
		await tool.execute("cg-nospawn-1", { action: "query", symbol: "alpha" });
		await tool.execute("cg-nospawn-2", { action: "callers", symbol: "alpha" });
		await tool.execute("cg-nospawn-3", { action: "status" });
		await tool.execute("cg-nospawn-4", { action: "files" });
		expect(execSpy).not.toHaveBeenCalled();
	});
});

describe("codegraph sync", () => {
	test("runs the CLI once from the index root and reports post-sync counts", async () => {
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/codegraph");
		const execSpy = vi.spyOn(execModule, "execCommand").mockResolvedValue({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		});
		const updates: string[] = [];
		const result = await new CodegraphTool(createSession(fixtureRoot)).execute(
			"cg-sync",
			{ action: "sync" },
			undefined,
			update => {
				for (const part of update.content) {
					if (part.type === "text") updates.push(part.text);
				}
			},
		);
		expect(whichSpy).toHaveBeenCalledWith("codegraph", { cache: piUtils.WhichCachePolicy.Fresh });
		expect(execSpy).toHaveBeenCalledWith("/usr/bin/codegraph", ["sync", "-q"], fixtureRoot, {
			signal: undefined,
			timeout: 120000,
		});
		expect(updates[0]).toContain("Syncing the codegraph index");
		const text = textOf(result);
		expect(text).toContain("Synced in");
		expect(text).toContain(
			`${FIXTURE_FILES.length} files · ${FIXTURE_NODES.length} nodes · ${FIXTURE_EDGES.length} edges`,
		);
		expect(result.useless).toBeUndefined();
	});

	test("fails with install guidance when the CLI is absent", async () => {
		vi.spyOn(piUtils, "$which").mockReturnValue(null);
		const execSpy = vi.spyOn(execModule, "execCommand");
		await expect(
			new CodegraphTool(createSession(fixtureRoot)).execute("cg-sync-absent", { action: "sync" }),
		).rejects.toThrow("`codegraph` CLI not on PATH");
		expect(execSpy).not.toHaveBeenCalled();
	});

	test("fails with init guidance when no index exists to sync", async () => {
		vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/codegraph");
		const execSpy = vi.spyOn(execModule, "execCommand");
		await expect(
			new CodegraphTool(createSession(plainRoot)).execute("cg-sync-noindex", { action: "sync" }),
		).rejects.toThrow("codegraph init -i");
		expect(execSpy).not.toHaveBeenCalled();
	});

	test("surfaces a failing sync with the CLI output and init guidance", async () => {
		vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/codegraph");
		vi.spyOn(execModule, "execCommand").mockResolvedValue({
			stdout: "",
			stderr: "boom: partial index",
			code: 1,
			killed: false,
		});
		await expect(
			new CodegraphTool(createSession(fixtureRoot)).execute("cg-sync-fail", { action: "sync" }),
		).rejects.toThrow("codegraph sync failed (exit 1): boom: partial index");
	});

	test("reports a timeout when the CLI is killed without a caller abort", async () => {
		vi.spyOn(piUtils, "$which").mockReturnValue("/usr/bin/codegraph");
		vi.spyOn(execModule, "execCommand").mockResolvedValue({
			stdout: "",
			stderr: "",
			code: 0,
			killed: true,
		});
		await expect(
			new CodegraphTool(createSession(fixtureRoot)).execute("cg-sync-timeout", { action: "sync" }),
		).rejects.toThrow("codegraph sync timed out after 120s");
	});
});
