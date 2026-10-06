/**
 * `codegraph`: structural queries over the local codegraph index — symbol
 * search, callers/callees, change impact, affected tests, indexed-file
 * listings — so "who depends on X / what breaks if X changes" comes from the
 * graph rather than a text-search guess.
 *
 * Every action except `sync` reads `.codegraph/codegraph.db` in process
 * (see `./queries.ts`); `sync` shells out to the `codegraph` CLI because
 * re-indexing must run the indexer itself. Ranking and traversal mirror the
 * upstream CLI so a tool answer agrees with one obtained from the shell.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "bun:sqlite";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { applyListLimit } from "@oh-my-pi/pi-tui/tools/list-limit";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	$which,
	WhichCachePolicy,
	formatBytes,
	formatDuration,
	formatGroupedPaths,
	formatNumber,
	prompt,
} from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import codegraphDescription from "../../prompts/tools/codegraph.md" with { type: "text" };
import { execCommand } from "../../exec/exec";
import { cfgCodegraphEnabled, cfgToolsMaxTimeout } from "../settings";
import { toolResult } from "../tool-result";
import { throwIfAborted } from "../tool-errors";
import { clampTimeout } from "../tool-timeouts";
import {
	type CodegraphNode,
	codegraphDbPath,
	compileTestFilter,
	computePendingChanges,
	detectIndexWorktreeMismatch,
	getAffectedTests,
	getCallers,
	getCallees,
	getIndexStats,
	getImpact,
	getJournalMode,
	isGeneratedFile,
	listIndexedFiles,
	openCodegraphIndex,
	resolveSymbolTargets,
	searchNodes,
} from "./queries";

const codegraphSchema = type({
	action: type("'status' | 'query' | 'callers' | 'callees' | 'impact' | 'affected' | 'files' | 'sync'").describe(
		"codegraph operation",
	),
	"symbol?": type("string").describe("symbol name or search text (query, callers, callees, impact)"),
	"files?": type("string[]").describe("changed file paths (affected)"),
	"kind?": type("string").describe(
		"restrict results to one node kind (function, method, class, interface, trait, ...)",
	),
	"limit?": type("number").describe("max results"),
	"depth?": type("number").describe("traversal depth: impact 1-10 (default 2), affected (default 5)"),
	"testFilter?": type("string").describe("glob selecting test files (affected); replaces the default test patterns"),
	"dir?": type("string").describe("directory scope on index-root paths (files)"),
	"pattern?": type("string").describe("glob over index-root paths (files)"),
	"format?": type("'flat' | 'tree' | 'grouped'").describe("path listing layout (files)"),
	"maxDepth?": type("number").describe("maximum directory depth in separators: dir/a.ts is 1 (files)"),
});

type CodegraphInput = typeof codegraphSchema.infer;

/** Result rows a `codegraph` call may present, plus the index root the rows describe. */
export interface CodegraphToolDetails {
	action: CodegraphInput["action"];
	indexRoot?: string;
	/** Symbol/query text the action resolved. */
	symbol?: string;
	/** Rows presented in the text output. */
	resultCount?: number;
	meta?: OutputMeta;
}

/** The list-shaped actions and their output bounds. `status`/`sync` are prose, not lists. */
type ListAction = "query" | "callers" | "callees" | "impact" | "affected" | "files";

interface LimitBounds {
	/** Result cap used when the caller omits `limit`. */
	def: number;
	/** Hard ceiling `limit` clamps to; the capped-suggestion notice never advises past it. */
	max: number;
}

const LIST_LIMITS: Record<ListAction, LimitBounds> = {
	query: { def: 10, max: 100 },
	callers: { def: 20, max: 100 },
	callees: { def: 20, max: 100 },
	impact: { def: 200, max: 1000 },
	affected: { def: 200, max: 1000 },
	files: { def: 200, max: 1000 },
};

/** Per-action default and ceiling for `depth`; `affected` has no meaningful ceiling (the BFS terminates on its visited set). */
const IMPACT_DEFAULT_DEPTH = 2;
const AFFECTED_DEFAULT_DEPTH = 5;

/** `status` lists at most this many pending paths; the count line always carries the totals. */
const PENDING_LISTED = 10;

/** Resolved-target lines shown above merged `callers`/`callees` results when several symbols match. */
const TARGET_LIST_CAP = 5;

/**
 * Walk up from `startDir` for the directory owning `.codegraph/codegraph.db`.
 * Checked fresh on every read — a cached answer goes stale the moment the
 * user runs `codegraph init`.
 */
export function findCodegraphIndexRoot(startDir: string): string | null {
	let dir = path.resolve(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".codegraph", "codegraph.db"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Resolve `codegraph.enabled` for a session: `on` always, `off` never, `auto`
 * only when an index exists at or above the session cwd. Gates tool creation
 * and the `codegraph` hints in sibling tool prompts.
 */
export function isCodegraphEnabled(session: ToolSession): boolean {
	const mode = cfgCodegraphEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	return findCodegraphIndexRoot(session.cwd) !== null;
}

/** Structural index queries: symbol search, callers/callees, impact, affected tests, indexed files, sync. */
export class CodegraphTool implements AgentTool<typeof codegraphSchema, CodegraphToolDetails> {
	readonly name = "codegraph";
	readonly approval = "read" as const;
	readonly loadMode = "discoverable";
	readonly label = "Codegraph";
	readonly summary = "Structural queries over the codegraph index: callers, impact, affected tests, files";
	readonly description = prompt.render(codegraphDescription);
	readonly parameters = codegraphSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: CodegraphInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CodegraphToolDetails>,
	): Promise<AgentToolResult<CodegraphToolDetails>> {
		throwIfAborted(signal);
		if (params.action === "sync") return executeSync(this.session, signal, onUpdate);
		const indexRoot = findCodegraphIndexRoot(this.session.cwd);
		if (indexRoot === null) throw new ToolError(noIndexMessage(this.session.cwd));
		const db = await openCodegraphIndex(indexRoot);
		try {
			switch (params.action) {
				case "status":
					return await executeStatus(db, this.session, indexRoot, signal);
				case "query":
					return executeQuery(db, params);
				case "callers":
					return executeRelations(db, params, "callers");
				case "callees":
					return executeRelations(db, params, "callees");
				case "impact":
					return executeImpact(db, params);
				case "affected":
					return executeAffected(db, this.session, indexRoot, params);
				case "files":
					return executeFiles(db, params);
				default:
					// `sync` returned above; the action union has no other member.
					throw new ToolError("Unsupported codegraph action");
			}
		} finally {
			db.close();
		}
	}
}

function noIndexMessage(cwd: string): string {
	return (
		`No .codegraph index found above ${shortenPath(cwd)}. Build one with \`codegraph init -i\` ` +
		`in the project root (bash); \`action: "sync"\` refreshes an already-built index.`
	);
}

function requireSymbol(params: CodegraphInput, action: ListAction): string {
	const symbol = params.symbol?.trim();
	if (symbol === undefined || symbol.length === 0) {
		throw new ToolError(`\`symbol\` is required for action "${action}"`);
	}
	return symbol;
}

function clampInt(raw: number | undefined, def: number, min: number, max: number): number {
	if (raw === undefined || !Number.isFinite(raw)) return def;
	return Math.min(max, Math.max(min, Math.floor(raw)));
}

interface ResolvedLimit {
	/** Effective result cap after clamping into the action's bounds. */
	limit: number;
	/** Notes surfaced when a caller-supplied `limit` exceeded the ceiling. */
	notes: string[];
}

function resolveLimit(raw: number | undefined, bounds: LimitBounds): ResolvedLimit {
	const limit = clampInt(raw, bounds.def, 1, bounds.max);
	const clampedFrom =
		raw !== undefined && Number.isFinite(raw) && Math.floor(raw) > limit ? Math.floor(raw) : undefined;
	return {
		limit,
		notes: clampedFrom === undefined ? [] : [`Requested limit ${clampedFrom} clamped to the max of ${bounds.max}.`],
	};
}

interface CappedList<T> {
	items: T[];
	/** `LimitsInput.resultLimit` — absent when the list fit inside the cap. */
	resultLimit?: { reached: number; suggestion: number | null };
	/** Clamp notes accumulated while resolving the limit. */
	notes: string[];
}

/**
 * Cap a result list and shape its limit notice. The doubled suggestion is
 * capped at the action's ceiling: once results already reach the maximum
 * there is no larger usable limit, so the "use limit=" advice is suppressed
 * instead of recommending a value the next call clamps straight back.
 */
function capList<T>(items: T[], resolved: ResolvedLimit, bounds: LimitBounds): CappedList<T> {
	const listLimit = applyListLimit(items, { limit: resolved.limit });
	const reached = listLimit.meta.resultLimit;
	if (reached === undefined) return { items: listLimit.items, notes: resolved.notes };
	const suggestion = Math.min(reached.reached * 2, bounds.max);
	return {
		items: listLimit.items,
		resultLimit:
			suggestion > reached.reached
				? { reached: reached.reached, suggestion }
				: { reached: reached.reached, suggestion: null },
		notes: resolved.notes,
	};
}

/** Body text plus its notes, separated so the rows stay one contiguous block. */
function joinNotes(body: string, notes: readonly string[]): string {
	return notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body;
}

function normalizeKinds(kind: string | undefined): string[] | undefined {
	const trimmed = kind?.trim().toLowerCase();
	return trimmed === undefined || trimmed.length === 0 ? undefined : [trimmed];
}

/** One result row: `kind qualified.name — path:line`, optionally with a flattened signature after `·`. */
function describeNode(node: CodegraphNode, options?: { signature?: boolean }): string {
	const location =
		node.filePath === null ? "" : ` — ${node.filePath}${node.startLine === null ? "" : `:${node.startLine}`}`;
	const head = `${node.kind} ${node.qualifiedName}${location}`;
	if (options?.signature !== true || node.signature === null || node.signature.length === 0) return head;
	// Signatures span lines and carry tabs; fold them so a row stays one row.
	const flattened = replaceTabs(node.signature).replace(/\s*\n\s*/g, " ");
	return `${head} · ${truncateToWidth(flattened, TRUNCATE_LENGTHS.LONG)}`;
}

/** Union across resolved targets, first occurrence wins — one node can relate to several exact matches. */
function mergeNodeGroups(groups: ReadonlyArray<readonly CodegraphNode[]>): CodegraphNode[] {
	const seen = new Set<string>();
	const merged: CodegraphNode[] = [];
	for (const group of groups) {
		for (const node of group) {
			if (seen.has(node.id)) continue;
			seen.add(node.id);
			merged.push(node);
		}
	}
	return merged;
}

/**
 * Rebase a caller-supplied path onto the index root: rows are stored
 * index-root-relative while the model may pass cwd-relative or absolute ones.
 * Paths leaving the index fall back to the raw text (they match nothing).
 */
function toIndexPath(rawPath: string, cwd: string, indexRoot: string): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) return "";
	const relative = path.relative(indexRoot, path.resolve(cwd, trimmed));
	return relative.startsWith("..") || path.isAbsolute(relative) ? trimmed.replace(/^\.\//, "") : relative;
}

function symbolNotFound(action: CodegraphInput["action"], symbol: string): AgentToolResult<CodegraphToolDetails> {
	return toolResult<CodegraphToolDetails>({ action, symbol })
		.text(`No symbol matching "${symbol}" in the index; use action: "query" to search for it.`)
		.useless()
		.done();
}

async function executeStatus(
	db: Database,
	session: ToolSession,
	indexRoot: string,
	signal?: AbortSignal,
): Promise<AgentToolResult<CodegraphToolDetails>> {
	const [stats, pending, mismatch] = await Promise.all([
		getIndexStats(db, indexRoot),
		computePendingChanges(db, indexRoot, signal),
		detectIndexWorktreeMismatch(session.cwd, indexRoot),
	]);
	const details: CodegraphToolDetails = { action: "status", indexRoot, resultCount: stats.fileCount };
	const lines: string[] = [];
	if (mismatch) {
		lines.push(
			`⚠ Query runs in ${shortenPath(mismatch.worktreeRoot)} but the index belongs to ${shortenPath(mismatch.indexRoot)} — results describe the index's tree.`,
		);
	}
	lines.push(`Index: ${shortenPath(codegraphDbPath(indexRoot))} (journal ${getJournalMode(db)})`);
	lines.push(
		`${formatNumber(stats.fileCount)} files · ${formatNumber(stats.nodeCount)} nodes · ${formatNumber(stats.edgeCount)} edges · DB ${formatBytes(stats.dbBytes)}`,
	);
	const kinds = stats.nodesByKind.slice(0, 5);
	if (kinds.length > 0) {
		lines.push(`Top kinds: ${kinds.map(entry => `${entry.kind} ${formatNumber(entry.count)}`).join(" · ")}`);
	}
	const languages = stats.filesByLanguage.slice(0, 5);
	if (languages.length > 0) {
		lines.push(
			`Languages: ${languages.map(entry => `${entry.language ?? "unknown"} ${formatNumber(entry.count)}`).join(" · ")}`,
		);
	}
	if (pending === null) {
		lines.push("Pending changes: skipped (not a git checkout).");
	} else {
		const pendingFiles = [
			...pending.modified.map(entry => ({ code: "M", entry })),
			...pending.added.map(entry => ({ code: "A", entry })),
			...pending.removed.map(entry => ({ code: "D", entry })),
		];
		if (pendingFiles.length === 0) {
			lines.push("Pending changes: none — the index matches the working tree.");
		} else {
			lines.push(
				`Pending changes: ${pending.modified.length} modified, ${pending.added.length} added, ${pending.removed.length} removed — run \`action: "sync"\` to refresh.`,
			);
			lines.push(...pendingFiles.slice(0, PENDING_LISTED).map(item => `${item.code} ${item.entry}`));
			if (pendingFiles.length > PENDING_LISTED) lines.push(`… ${pendingFiles.length - PENDING_LISTED} more`);
		}
	}
	return toolResult(details).text(lines.join("\n")).done();
}

function executeQuery(db: Database, params: CodegraphInput): AgentToolResult<CodegraphToolDetails> {
	const query = requireSymbol(params, "query");
	const bounds = LIST_LIMITS.query;
	const resolved = resolveLimit(params.limit, bounds);
	const found = searchNodes(db, query, { limit: resolved.limit, kinds: normalizeKinds(params.kind) });
	if (found.length === 0) {
		return toolResult<CodegraphToolDetails>({ action: "query", symbol: query, resultCount: 0 })
			.text(`No matches for "${query}". Try a shorter prefix, or action: "files" to browse indexed paths.`)
			.useless()
			.done();
	}
	// Generated files demote rather than vanish: sink them below hand-written
	// hits after scoring so the ranking still reflects name/path relevance.
	const handWritten: CodegraphNode[] = [];
	const generated: CodegraphNode[] = [];
	for (const node of found) {
		if (node.filePath !== null && isGeneratedFile(node.filePath)) generated.push(node);
		else handWritten.push(node);
	}
	const capped = capList([...handWritten, ...generated], resolved, bounds);
	const details: CodegraphToolDetails = { action: "query", symbol: query, resultCount: capped.items.length };
	const body = capped.items.map(node => describeNode(node, { signature: true })).join("\n");
	return toolResult(details).text(joinNotes(body, capped.notes)).limits({ resultLimit: capped.resultLimit }).done();
}

/**
 * `callers`/`callees` of every resolved target, merged and deduplicated —
 * several exact matches for one symbol answer together, with the resolved
 * targets listed first so the model can see which symbols answered.
 */
function executeRelations(
	db: Database,
	params: CodegraphInput,
	direction: "callers" | "callees",
): AgentToolResult<CodegraphToolDetails> {
	const symbol = requireSymbol(params, direction);
	const bounds = LIST_LIMITS[direction];
	const resolved = resolveLimit(params.limit, bounds);
	const targets = resolveSymbolTargets(db, symbol);
	if (targets.length === 0) return symbolNotFound(direction, symbol);
	const fetchRelated = direction === "callers" ? getCallers : getCallees;
	const merged = mergeNodeGroups(targets.map(target => fetchRelated(db, target.id)));
	const capped = capList(merged, resolved, bounds);
	const details: CodegraphToolDetails = { action: direction, symbol, resultCount: capped.items.length };
	const label = direction === "callers" ? "Callers" : "Callees";
	const header =
		targets.length === 1
			? `${label} of ${describeNode(targets[0])}`
			: `${label} of ${targets.length} symbols matching "${symbol}"`;
	if (capped.items.length === 0) {
		return toolResult(details).text(`${header} — none.`).useless().done();
	}
	const bodyLines = [`${header}:`];
	if (targets.length > 1) {
		bodyLines.push(...targets.slice(0, TARGET_LIST_CAP).map(target => `  ${describeNode(target)}`));
		if (targets.length > TARGET_LIST_CAP) bodyLines.push(`  … ${targets.length - TARGET_LIST_CAP} more matches`);
	}
	bodyLines.push(...capped.items.map(node => describeNode(node)));
	return toolResult(details)
		.text(joinNotes(bodyLines.join("\n"), capped.notes))
		.limits({ resultLimit: capped.resultLimit })
		.done();
}

function executeImpact(db: Database, params: CodegraphInput): AgentToolResult<CodegraphToolDetails> {
	const symbol = requireSymbol(params, "impact");
	const bounds = LIST_LIMITS.impact;
	const resolved = resolveLimit(params.limit, bounds);
	const targets = resolveSymbolTargets(db, symbol);
	if (targets.length === 0) return symbolNotFound("impact", symbol);
	const depth = clampInt(params.depth, IMPACT_DEFAULT_DEPTH, 1, 10);
	const { nodes, truncated } = getImpact(db, targets, depth);
	const capped = capList(nodes, resolved, bounds);
	const details: CodegraphToolDetails = { action: "impact", symbol, resultCount: capped.items.length };
	const header =
		targets.length === 1
			? `Impact of ${describeNode(targets[0])} (depth ${depth})`
			: `Impact of ${targets.length} symbols matching "${symbol}" (depth ${depth})`;
	const notes = [...capped.notes];
	if (truncated) {
		notes.push("Traversal hit the node ceiling — impacted set incomplete; lower `depth` for a bounded answer.");
	}
	const body = `${header}:\n${capped.items.map(node => describeNode(node)).join("\n")}`;
	return toolResult(details).text(joinNotes(body, notes)).limits({ resultLimit: capped.resultLimit }).done();
}

function executeAffected(
	db: Database,
	session: ToolSession,
	indexRoot: string,
	params: CodegraphInput,
): AgentToolResult<CodegraphToolDetails> {
	if (params.files === undefined || params.files.length === 0) {
		throw new ToolError('`files` is required for action "affected"');
	}
	const changed = params.files.map(file => toIndexPath(file, session.cwd, indexRoot)).filter(file => file.length > 0);
	if (changed.length === 0) throw new ToolError("`files` must contain at least one non-empty path");
	const bounds = LIST_LIMITS.affected;
	const resolved = resolveLimit(params.limit, bounds);
	const depth = clampInt(params.depth, AFFECTED_DEFAULT_DEPTH, 1, Number.MAX_SAFE_INTEGER);
	const { tests, traversed, truncated } = getAffectedTests(db, changed, {
		depth,
		isTestFile: compileTestFilter(params.testFilter),
	});
	const capped = capList(tests, resolved, bounds);
	const details: CodegraphToolDetails = { action: "affected", resultCount: capped.items.length };
	const header = `Test files affected by ${changed.length} changed file${changed.length === 1 ? "" : "s"} (depth ${depth}, ${traversed} dependents walked)`;
	if (capped.items.length === 0) {
		// A ceiling hit makes "none" a non-answer: never state definitive
		// absence for a walk that stopped early.
		const message = truncated
			? `${header}: the dependent-file walk hit its ceiling before reaching a test file — incomplete; lower \`depth\` or set \`testFilter\`.`
			: `${header}: none.`;
		return toolResult(details).text(message).useless().done();
	}
	const notes = [...capped.notes];
	if (truncated) {
		notes.push("Dependent-file walk hit its ceiling — test list incomplete; lower `depth`.");
	}
	const body = `${header}:\n${capped.items.join("\n")}`;
	return toolResult(details).text(joinNotes(body, notes)).limits({ resultLimit: capped.resultLimit }).done();
}

function executeFiles(db: Database, params: CodegraphInput): AgentToolResult<CodegraphToolDetails> {
	const bounds = LIST_LIMITS.files;
	const resolved = resolveLimit(params.limit, bounds);
	const matches = listIndexedFiles(db, {
		dir: params.dir,
		pattern: params.pattern,
		maxDepth: params.maxDepth,
	});
	const capped = capList(matches, resolved, bounds);
	const details: CodegraphToolDetails = { action: "files", resultCount: capped.items.length };
	if (capped.items.length === 0) {
		return toolResult(details)
			.text(`No indexed files${describeFileFilters(params)}.`)
			.useless()
			.done();
	}
	const body =
		params.format === "flat"
			? capped.items.join("\n")
			: params.format === "tree"
				? formatFileTree(capped.items)
				: formatGroupedPaths(capped.items);
	const notes = [...capped.notes];
	if (capped.resultLimit !== undefined) {
		notes.push(
			`${matches.length - capped.items.length} more indexed paths — raise \`limit\` or narrow \`dir\`/\`pattern\`.`,
		);
	}
	return toolResult(details).text(joinNotes(body, notes)).limits({ resultLimit: capped.resultLimit }).done();
}

function describeFileFilters(params: CodegraphInput): string {
	const filters: string[] = [];
	const dir = params.dir?.trim();
	if (dir !== undefined && dir.length > 0) filters.push(`dir "${dir}"`);
	const pattern = params.pattern?.trim();
	if (pattern !== undefined && pattern.length > 0) filters.push(`pattern "${pattern}"`);
	if (params.maxDepth !== undefined) filters.push(`maxDepth ${params.maxDepth}`);
	return filters.length > 0 ? ` matching ${filters.join(", ")}` : "";
}

interface FileTreeEntry {
	name: string;
	children?: Map<string, FileTreeEntry>;
}

/**
 * Path tree with box connectors — the CLI's `tree` format groups files by
 * language instead; this folds shared path prefixes, which is what an agent
 * browsing index-root paths actually wants to read.
 */
function formatFileTree(paths: readonly string[]): string {
	const root = new Map<string, FileTreeEntry>();
	for (const filePath of paths) {
		const segments = filePath.split("/");
		let level = root;
		for (let index = 0; index < segments.length; index++) {
			const name = segments[index];
			let entry = level.get(name);
			if (entry === undefined) {
				entry = { name };
				level.set(name, entry);
			}
			if (index < segments.length - 1) {
				entry.children ??= new Map();
				level = entry.children;
			}
		}
	}
	const lines: string[] = [];
	const render = (level: Map<string, FileTreeEntry>, prefix: string): void => {
		const entries = [...level.values()];
		entries.forEach((entry, index) => {
			const isLast = index === entries.length - 1;
			const branch = isLast ? "└── " : "├── ";
			if (entry.children === undefined) {
				lines.push(`${prefix}${branch}${entry.name}`);
				return;
			}
			lines.push(`${prefix}${branch}${entry.name}/`);
			render(entry.children, prefix + (isLast ? "    " : "│   "));
		});
	};
	render(root, "");
	return lines.join("\n");
}

/**
 * Re-index through the `codegraph` CLI — the one action that must spawn a
 * process. Runs from the index root so the CLI syncs the project whose
 * `.codegraph` the queries read.
 */
async function executeSync(
	session: ToolSession,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<CodegraphToolDetails>,
): Promise<AgentToolResult<CodegraphToolDetails>> {
	// Fresh lookup: the CLI can be installed mid-session, and the cached
	// negative answer would otherwise stick until restart.
	const binary = $which("codegraph", { cache: WhichCachePolicy.Fresh });
	if (binary === null) {
		throw new ToolError(
			"`codegraph` CLI not on PATH — install it to build or refresh an index; every other action reads an existing index in-process.",
		);
	}
	const indexRoot = findCodegraphIndexRoot(session.cwd);
	if (indexRoot === null) {
		throw new ToolError(
			`No .codegraph index above ${shortenPath(session.cwd)} — build one first with \`codegraph init -i\` in the project root (bash), then sync.`,
		);
	}
	const timeoutMs = clampTimeout("codegraph", undefined, cfgToolsMaxTimeout.get(session.settings)) * 1000;
	onUpdate?.({ content: [{ type: "text", text: `Syncing the codegraph index in ${shortenPath(indexRoot)}…` }] });
	const started = performance.now();
	const result = await execCommand(binary, ["sync", "-q"], indexRoot, { signal, timeout: timeoutMs });
	if (result.killed) {
		throwIfAborted(signal);
		throw new ToolError(
			`codegraph sync timed out after ${Math.round(timeoutMs / 1000)}s — rerun \`action: "sync"\`, or sync from bash.`,
		);
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim();
		throw new ToolError(
			`codegraph sync failed (exit ${result.code})${detail.length > 0 ? `: ${detail}` : ""}. ` +
				"If the index was never built, run `codegraph init -i` first.",
		);
	}
	const db = await openCodegraphIndex(indexRoot);
	try {
		const stats = await getIndexStats(db, indexRoot);
		const details: CodegraphToolDetails = { action: "sync", indexRoot, resultCount: stats.fileCount };
		const text =
			`Synced in ${formatDuration(performance.now() - started)}\n` +
			`${formatNumber(stats.fileCount)} files · ${formatNumber(stats.nodeCount)} nodes · ${formatNumber(stats.edgeCount)} edges · DB ${formatBytes(stats.dbBytes)}`;
		return toolResult(details).text(text).done();
	} finally {
		db.close();
	}
}
