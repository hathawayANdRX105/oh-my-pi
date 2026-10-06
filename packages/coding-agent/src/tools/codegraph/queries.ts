/**
 * Read-only queries over a codegraph project index (`.codegraph/codegraph.db`,
 * written by the external `codegraph` CLI).
 *
 * Every lookup runs in-process through `bun:sqlite` — no CLI subprocess except
 * the `sync` action in `index.ts`, which must run the indexer itself. Ranking,
 * traversal and pending-change detection mirror the upstream CLI
 * (`codegraph query|callers|callees|impact|affected|files|status`) so a result
 * here agrees with one obtained from the shell; the model-facing layout is
 * this tool's own (see `index.ts`).
 *
 * Deliberate divergences from the CLI, each noted at its code:
 * - `searchNodes` drops the fuzzy (edit-distance) third tier: prefix and
 *   substring tiers already cover symbol-shaped queries, and a model retries
 *   with a corrected name when nothing matches.
 * - `listIndexedFiles(dir)` matches on directory boundaries, so `dir: "src"`
 *   cannot pull in `srcfoo.ts` (bare `startsWith` would).
 * - `computePendingChanges` reports `untracked: "all"` and parses
 *   NUL-terminated porcelain, so files inside a wholly-untracked directory and
 *   paths that git would C-quote are not lost.
 * - `getImpact` / `getAffectedTests` cap traversal (5000 nodes / 2000 files)
 *   instead of walking an adversarial graph to completion.
 */
import { type SQLQueryBindings, Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { findRepoRoot } from "../../capability/fs";
import { throwIfAborted } from "../tool-errors";
import { openSqliteReadConnection } from "../sqlite-reader";

/** Highest `schema_versions` value this reader understands; anything else is a hard error rather than a wrong-shaped answer. */
export const EXPECTED_SCHEMA_VERSION = 4;

/** Impact ceiling — a hub symbol at depth 10 would otherwise walk most of the graph. */
const MAX_IMPACT_NODES = 5000;

/** Affected-tests ceiling; upstream `affected` has none. */
const MAX_AFFECTED_FILES = 2000;

/** Edge kinds that make the source depend on the target (`source → target` = caller → callee). */
const RELATION_EDGE_KINDS_SQL = ["calls", "references", "imports"].map(kind => `'${kind}'`).join(", ");

/** Kinds whose members are container nodes during impact: changing a class impacts its methods too. */
const CONTAINER_KINDS = new Set(["class", "interface", "struct", "trait", "protocol", "module", "enum"]);

const NODE_COLUMNS = "id, kind, name, qualified_name, file_path, start_line, signature, is_exported";

/** Pad count for batched `id IN (...)` lookups so `db.query` caches one statement, not one per chunk size. */
const ID_CHUNK = 400;
const ID_CHUNK_SQL = `SELECT ${NODE_COLUMNS} FROM nodes WHERE id IN (${Array.from({ length: ID_CHUNK }, () => "?").join(",")})`;
/** Empty-string pad: ids are `kind:hash`, so a padded slot can never match a row. */
const ID_SENTINEL = "";

/** A symbol row as the model sees it — the subset of `nodes` this tool reports. */
export interface CodegraphNode {
	id: string;
	kind: string;
	name: string;
	qualifiedName: string;
	filePath: string | null;
	startLine: number | null;
	signature: string | null;
	isExported: boolean;
}

export interface SearchOptions {
	/** Cap applied after rescoring; candidate fetches run over this many first. */
	limit: number;
	/** Restrict to these node kinds, as stored (lowercase snake_case). */
	kinds?: readonly string[];
}

export interface ImpactResult {
	/** Focal targets plus every symbol reachable within `depth` reverse hops, sorted by location. */
	nodes: CodegraphNode[];
	/** True when the walk stopped at the node ceiling. */
	truncated: boolean;
}

export interface AffectedResult {
	/** Test files reachable within `depth` hops, sorted; a changed test file seeds itself. */
	tests: string[];
	/** Dependent files walked (changed seeds excluded), bounded by the file ceiling. */
	traversed: number;
	/** True when the walk stopped at the file ceiling. */
	truncated: boolean;
}

export interface PendingChanges {
	added: string[];
	modified: string[];
	removed: string[];
}

export interface IndexStats {
	fileCount: number;
	nodeCount: number;
	edgeCount: number;
	nodesByKind: Array<{ kind: string; count: number }>;
	/** `language` is null for indexed files whose language could not be derived. */
	filesByLanguage: Array<{ language: string | null; count: number }>;
	dbBytes: number;
}

export interface IndexWorktreeMismatch {
	/** Git working tree containing the query. */
	worktreeRoot: string;
	/** Git working tree the index belongs to. */
	indexRoot: string;
}

interface NodeRow {
	id: string;
	kind: string;
	name: string;
	qualified_name: string | null;
	file_path: string | null;
	start_line: number | null;
	signature: string | null;
	is_exported: number;
}

interface ScoredNode {
	node: CodegraphNode;
	score: number;
}

function queryRows<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T[] {
	return db.query(sql).all(...params) as T[];
}

function queryRow<T>(db: Database, sql: string, ...params: SQLQueryBindings[]): T | null {
	return (db.query(sql).get(...params) ?? null) as T | null;
}

function kindFilterSql(kinds?: readonly string[]): string {
	return kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
}

export function codegraphDbPath(indexRoot: string): string {
	return path.join(indexRoot, ".codegraph", "codegraph.db");
}

/**
 * Open the index read-only with the shared read-tool opener (WAL sidecar init,
 * `query_only`, busy timeout), then pin the schema version: a newer index may
 * have reshaped tables this reader would otherwise silently misread.
 */
export async function openCodegraphIndex(indexRoot: string): Promise<Database> {
	const dbPath = codegraphDbPath(indexRoot);
	let db: Database;
	try {
		db = await openSqliteReadConnection(dbPath);
	} catch (error) {
		throw new ToolError(
			`Cannot open the codegraph index at ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let version: number | null = null;
	try {
		version =
			queryRow<{ version: number | null }>(db, "SELECT MAX(version) AS version FROM schema_versions")?.version ??
			null;
	} catch {
		version = null;
	}
	if (version !== EXPECTED_SCHEMA_VERSION) {
		db.close();
		throw new ToolError(
			version === null
				? `${dbPath} is not a codegraph index (no readable schema_versions). Run \`codegraph init -i\` to build one.`
				: `Codegraph index schema is v${version} but this build reads v${EXPECTED_SCHEMA_VERSION}. Rebuild it with \`codegraph init -i\`.`,
		);
	}
	return db;
}

function toNode(row: NodeRow): CodegraphNode {
	return {
		id: row.id,
		kind: row.kind,
		name: row.name,
		qualifiedName: row.qualified_name ?? row.name,
		filePath: row.file_path,
		startLine: row.start_line,
		signature: row.signature,
		isExported: row.is_exported === 1,
	};
}

function fetchNodes(db: Database, ids: readonly string[]): Map<string, CodegraphNode> {
	const found = new Map<string, CodegraphNode>();
	for (let start = 0; start < ids.length; start += ID_CHUNK) {
		const params = ids.slice(start, start + ID_CHUNK).slice();
		while (params.length < ID_CHUNK) params.push(ID_SENTINEL);
		for (const row of queryRows<NodeRow>(db, ID_CHUNK_SQL, ...params)) found.set(row.id, toNode(row));
	}
	return found;
}

/** Resolve ids to nodes, keeping first-occurrence order and dropping ids with no row. */
function orderedNodes(db: Database, ids: readonly string[]): CodegraphNode[] {
	const unique = [...new Set(ids)];
	const byId = fetchNodes(db, unique);
	return unique.flatMap(id => {
		const node = byId.get(id);
		return node ? [node] : [];
	});
}

function sortNodesByLocation(nodes: CodegraphNode[]): CodegraphNode[] {
	return nodes.sort(
		(a, b) =>
			(a.filePath ?? "").localeCompare(b.filePath ?? "") ||
			(a.startLine ?? 0) - (b.startLine ?? 0) ||
			a.name.localeCompare(b.name),
	);
}

// ---------------------------------------------------------------------------
// searchNodes: FTS prefix tier -> LIKE substring tier -> exact-name supplement
// -> multi-signal rescoring.
// ---------------------------------------------------------------------------

/**
 * Symbol/text search. Ranking mirrors the CLI: bm25 candidates (name-weighted),
 * a substring tier when FTS finds nothing, exact-name supplements seeded at the
 * best candidate score, then kind/path/name bonuses that put the symbol *named*
 * for the query above prose that merely mentions it.
 */
export function searchNodes(db: Database, query: string, options: SearchOptions): CodegraphNode[] {
	const text = query.trim();
	if (text.length === 0) return [];
	const { limit, kinds } = options;

	let results = searchNodesFts(db, text, limit, kinds);
	if (results.length === 0) results = searchNodesLike(db, text, limit, kinds);

	if (results.length > 0) {
		const seen = new Set(results.map(hit => hit.node.id));
		const bestCandidateScore = Math.max(...results.map(hit => hit.score));
		for (const term of text.split(/\s+/).filter(candidate => candidate.length >= 2)) {
			for (const row of exactNameRows(db, term, kinds)) {
				if (seen.has(row.id)) continue;
				seen.add(row.id);
				results.push({ node: toNode(row), score: bestCandidateScore });
			}
		}
	}

	const rescored = results.map(hit => ({
		node: hit.node,
		score:
			hit.score +
			kindBonus(hit.node.kind) +
			scorePathRelevance(hit.node.filePath ?? "", text) +
			nameMatchBonus(hit.node.name, text),
	}));
	rescored.sort((a, b) => b.score - a.score);
	return rescored.slice(0, limit).map(hit => hit.node);
}

function searchNodesFts(db: Database, query: string, limit: number, kinds?: readonly string[]): ScoredNode[] {
	// `::` separates qualifiers in Rust/C++/Ruby but is not an FTS token char:
	// without this split `stage_apply::run` strips down to `stage_applyrun`
	// and matches nothing (upstream codegraph #173).
	const ftsQuery = query
		.replace(/::/g, " ")
		.replace(/['"*():^]/g, "")
		.split(/\s+/)
		.filter(term => term.length > 0 && !/^(AND|OR|NOT|NEAR)$/i.test(term))
		.map(term => `"${term}"*`)
		.join(" OR ");
	if (ftsQuery.length === 0) return [];
	// bm25 column weights: name (20) dominates qualified name (5), signature (2)
	// and docstring (1), so a symbol named for the query beats prose mentioning
	// it. Candidates are fetched over the limit because rescoring below can
	// promote matches bm25 undervalues.
	const fetchLimit = Math.max(limit * 5, 100);
	const sql =
		`SELECT ${NODE_COLUMNS}, bm25(nodes_fts, 0, 20, 5, 1, 2) AS score ` +
		"FROM nodes_fts JOIN nodes ON nodes_fts.id = nodes.id " +
		`WHERE nodes_fts MATCH ?${kindFilterSql(kinds)} ORDER BY score LIMIT ?`;
	let rows: Array<NodeRow & { score: number }>;
	try {
		rows = queryRows(db, sql, ftsQuery, ...(kinds ?? []), fetchLimit);
	} catch {
		// Defensive: a query surviving the strip that the tokenizer still rejects
		// (e.g. a phrase it empties) degrades to the LIKE tier, not a tool error.
		return [];
	}
	// bm25 is negative (more negative = better); abs flips it onto the
	// higher-is-better scale the bonuses and final sort assume.
	return rows.map(row => ({ node: toNode(row), score: Math.abs(row.score) }));
}

function searchNodesLike(db: Database, query: string, limit: number, kinds?: readonly string[]): ScoredNode[] {
	const contains = `%${query}%`;
	const startsWith = `${query}%`;
	// `%`/`_` in the query stay unescaped, exactly like the CLI: `foo_bar`
	// still matches itself (`_` wildcards the literal underscore too) and a
	// stray `%` only widens a result list already capped by `limit`.
	const sql =
		`SELECT ${NODE_COLUMNS}, CASE ` +
		"WHEN name = ? THEN 1.0 WHEN name LIKE ? THEN 0.9 WHEN name LIKE ? THEN 0.8 " +
		"WHEN qualified_name LIKE ? THEN 0.7 ELSE 0.5 END AS score " +
		"FROM nodes WHERE (name LIKE ? OR qualified_name LIKE ? OR name LIKE ?)" +
		`${kindFilterSql(kinds)} ORDER BY score DESC, length(name) ASC LIMIT ?`;
	const rows = queryRows<NodeRow & { score: number }>(
		db,
		sql,
		query,
		startsWith,
		contains,
		contains,
		contains,
		contains,
		startsWith,
		...(kinds ?? []),
		limit,
	);
	return rows.map(row => ({ node: toNode(row), score: row.score }));
}

function exactNameRows(db: Database, term: string, kinds?: readonly string[]): NodeRow[] {
	return queryRows<NodeRow>(
		db,
		`SELECT ${NODE_COLUMNS} FROM nodes WHERE name = ? COLLATE NOCASE${kindFilterSql(kinds)} LIMIT 20`,
		term,
		...(kinds ?? []),
	);
}

// ---------------------------------------------------------------------------
// Scoring signals (port of upstream search/query-utils.js).
// ---------------------------------------------------------------------------

const KIND_BONUSES: Record<string, number> = {
	function: 10,
	method: 10,
	class: 8,
	interface: 9,
	type_alias: 6,
	struct: 6,
	trait: 9,
	enum: 5,
	component: 8,
	route: 9,
	module: 4,
	protocol: 9,
	property: 3,
	field: 3,
	variable: 2,
	constant: 3,
	enum_member: 3,
	namespace: 4,
	import: 1,
	export: 1,
	parameter: 0,
	file: 0,
};

function kindBonus(kind: string): number {
	return KIND_BONUSES[kind] ?? 0;
}

function nameMatchBonus(nodeName: string, query: string): number {
	const nameLower = nodeName.toLowerCase();
	const rawTerms = query
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.split(/[\s_.-]+/)
		.map(term => term.toLowerCase())
		.filter(term => term.length >= 2);
	const queryTokens = query
		.split(/\s+/)
		.map(term => term.toLowerCase())
		.filter(term => term.length >= 2);
	const queryLower = query.replace(/\s+/g, "").toLowerCase();
	if (nameLower === queryLower) return 80;
	// Multi-word query naming a short symbol exactly ("CacheBuilder build" vs `build`).
	if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60;
	// Scale prefix matches by length ratio so `Pod` -> `Pod` (exact, handled above)
	// scores far above `Pod` -> `PodGCControllerOptions` (ratio 0.125).
	if (nameLower.startsWith(queryLower)) {
		const ratio = queryLower.length / nameLower.length;
		return Math.round(10 + 30 * ratio);
	}
	if (rawTerms.length > 1 && rawTerms.every(term => nameLower.includes(term))) return 15;
	if (nameLower.includes(queryLower)) return 10;
	return 0;
}

/** Dropped from upstream: stem expansion (caching -> cache). Prefix tiers already widen those matches. */
const SEARCH_STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"in",
	"on",
	"at",
	"to",
	"for",
	"of",
	"with",
	"by",
	"from",
	"is",
	"it",
	"that",
	"this",
	"are",
	"was",
	"be",
	"has",
	"had",
	"have",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"can",
	"shall",
	"not",
	"no",
	"all",
	"each",
	"every",
	"how",
	"what",
	"where",
	"when",
	"who",
	"which",
	"why",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"she",
	"they",
	"show",
	"give",
	"tell",
	"been",
	"done",
	"made",
	"used",
	"using",
	"work",
	"works",
	"found",
	"also",
	"into",
	"then",
	"than",
	"just",
	"more",
	"some",
	"such",
	"over",
	"only",
	"out",
	"its",
	"so",
	"up",
	"as",
	"if",
	"look",
	"need",
	"needs",
	"want",
	"happen",
	"happens",
	"affect",
	"affected",
	"break",
	"breaks",
	"failing",
	"implemented",
	"implement",
	// Code-specific noise; common symbol verbs (get/set/add/build/find/list) stay in.
	"code",
	"file",
	"files",
	"function",
	"method",
	"class",
	"type",
	"fix",
	"bug",
	"called",
]);

/** Query terms for path scoring: compound identifiers preserved, camel/snake split, stop words dropped. */
function extractPathTerms(query: string): string[] {
	const tokens = new Set<string>();
	for (const match of query.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:[A-Z][a-z]+)+|[A-Z][a-z]+(?:[A-Z][a-z]*)+)\b/g)) {
		if (match[1] && match[1].length >= 3) tokens.add(match[1].toLowerCase());
	}
	for (const match of query.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b/g)) {
		if (match[1] && match[1].length >= 3) tokens.add(match[1].toLowerCase());
	}
	const camelSplit = query.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
	for (const word of camelSplit.replace(/[_.]+/g, " ").split(/[^a-zA-Z0-9]+/)) {
		const lower = word.toLowerCase();
		if (lower.length < 3 || SEARCH_STOP_WORDS.has(lower)) continue;
		tokens.add(lower);
	}
	return [...tokens];
}

function scorePathRelevance(filePath: string, query: string): number {
	const terms = extractPathTerms(query);
	if (terms.length === 0) return 0;
	const pathLower = filePath.toLowerCase();
	const fileName = path.posix.basename(pathLower);
	const dirName = path.posix.dirname(pathLower);
	let score = 0;
	for (const term of terms) {
		if (fileName.includes(term)) score += 10;
		if (dirName.includes(term)) score += 5;
		else if (pathLower.includes(term)) score += 3;
	}
	const queryLower = query.toLowerCase();
	const mentionsTests = queryLower.includes("test") || queryLower.includes("spec");
	if (!mentionsTests && isSearchTestFile(filePath)) score -= 15;
	return score;
}

/**
 * Broad "this is not production code" classifier feeding the query ranking
 * penalty (filename suffixes, test-ish directories, non-production dirs).
 * Wider than {@link compileTestFilter}'s patterns on purpose: ranking only
 * needs a hint, while `affected` decides which files get reported.
 */
function isSearchTestFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	const fileName = path.posix.basename(filePath);
	const lowerName = fileName.toLowerCase();
	if (
		lowerName.startsWith("test_") ||
		lowerName.startsWith("test.") ||
		/[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
		/(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
	) {
		return true;
	}
	if (
		lower.includes("/tests/") ||
		lower.includes("/test/") ||
		lower.includes("/__tests__/") ||
		lower.includes("/spec/") ||
		lower.includes("/specs/") ||
		lower.includes("/testlib/") ||
		lower.includes("/testing/") ||
		lower.startsWith("test/") ||
		lower.startsWith("tests/") ||
		lower.startsWith("spec/") ||
		lower.startsWith("specs/") ||
		/(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
	) {
		return true;
	}
	return NON_PRODUCTION_DIRS.some(dir => lower.includes(`/${dir}/`) || lower.startsWith(`${dir}/`));
}

const NON_PRODUCTION_DIRS = [
	"integration",
	"sample",
	"samples",
	"example",
	"examples",
	"fixture",
	"fixtures",
	"benchmark",
	"benchmarks",
	"demo",
	"demos",
];

// ---------------------------------------------------------------------------
// callers / callees.
// ---------------------------------------------------------------------------

/**
 * Resolve a symbol name to the nodes `callers`/`callees` traverse. When several
 * candidates compete only exact matches qualify (`name`, `ns.name`, `ns::name`);
 * an all-fuzzy result set falls back to its top hit so a near-miss still
 * answers instead of reporting "not found".
 *
 * Unlike the CLI, an exact target with no callers stays empty: upstream falls
 * back to the top match's callers there, silently answering for another symbol.
 */
export function resolveSymbolTargets(db: Database, symbol: string): CodegraphNode[] {
	const matches = searchNodes(db, symbol, { limit: 50 });
	if (matches.length === 0) return [];
	const needle = symbol.trim();
	const isExact = (node: CodegraphNode): boolean =>
		node.name === needle || node.name.endsWith(`.${needle}`) || node.name.endsWith(`::${needle}`);
	const exact = matches.filter(isExact);
	return exact.length > 0 ? exact : [matches[0]];
}

/** Symbols whose edges point into `nodeId` — who depends on it, deduplicated by node. */
export function getCallers(db: Database, nodeId: string): CodegraphNode[] {
	const rows = queryRows<{ source: string }>(
		db,
		`SELECT source FROM edges WHERE target = ? AND kind IN (${RELATION_EDGE_KINDS_SQL})`,
		nodeId,
	);
	return orderedNodes(
		db,
		rows.map(row => row.source),
	);
}

/** Symbols `nodeId` points at — what it depends on, deduplicated by node. */
export function getCallees(db: Database, nodeId: string): CodegraphNode[] {
	const rows = queryRows<{ target: string }>(
		db,
		`SELECT target FROM edges WHERE source = ? AND kind IN (${RELATION_EDGE_KINDS_SQL})`,
		nodeId,
	);
	return orderedNodes(
		db,
		rows.map(row => row.target),
	);
}

// ---------------------------------------------------------------------------
// impact: reverse BFS with same-depth container expansion.
// ---------------------------------------------------------------------------

/**
 * Everything a change to `targets` can reach: `depth` hops back along incoming
 * edges (clamped 1..10), plus at each hop the members of a container kind —
 * callers of a class's methods must appear when the class is the target.
 * Iterative rather than the CLI's recursion; same walk, no stack risk.
 */
export function getImpact(db: Database, targets: readonly CodegraphNode[], depth: number): ImpactResult {
	const maxDepth = Math.min(10, Math.max(1, Math.floor(depth)));
	const nodes = new Map<string, CodegraphNode>();
	for (const target of targets) nodes.set(target.id, target);
	const visited = new Set<string>();
	const stack = targets.map(target => ({ id: target.id, depth: 0 }));
	let truncated = false;
	let head = 0;
	while (head < stack.length && !truncated) {
		const current = stack[head++];
		if (current.depth >= maxDepth || visited.has(current.id)) continue;
		visited.add(current.id);

		const discovered: Array<{ id: string; depth: number }> = [];
		const focal = nodes.get(current.id);
		if (focal && CONTAINER_KINDS.has(focal.kind)) {
			// Same depth: a container's members are changed by changing the container.
			for (const row of queryRows<{ target: string }>(
				db,
				"SELECT target FROM edges WHERE source = ? AND kind = 'contains'",
				current.id,
			)) {
				discovered.push({ id: row.target, depth: current.depth });
			}
		}
		for (const row of queryRows<{ source: string }>(db, "SELECT source FROM edges WHERE target = ?", current.id)) {
			discovered.push({ id: row.source, depth: current.depth + 1 });
		}

		const fresh = [...new Map(discovered.filter(next => !nodes.has(next.id)).map(next => [next.id, next])).values()];
		if (fresh.length === 0) continue;
		const fetched = fetchNodes(
			db,
			fresh.map(next => next.id),
		);
		for (const next of fresh) {
			const node = fetched.get(next.id);
			if (!node) continue;
			if (nodes.size >= MAX_IMPACT_NODES) {
				truncated = true;
				break;
			}
			nodes.set(next.id, node);
			stack.push(next);
		}
	}
	return { nodes: sortNodesByLocation([...nodes.values()]), truncated };
}

// ---------------------------------------------------------------------------
// affected: dependent-file BFS to test files.
// ---------------------------------------------------------------------------

/** Upstream `affected` default patterns; a `testFilter` glob replaces them wholesale. */
const DEFAULT_TEST_PATTERNS = [/\.spec\./, /\.test\./, /\/__tests__\//, /\/tests?\//, /\/e2e\//, /\/spec\//];

/** Compile the `testFilter` glob (or the default patterns) into a path predicate. */
export function compileTestFilter(testFilter?: string): (filePath: string) => boolean {
	const trimmed = testFilter?.trim();
	if (trimmed === undefined || trimmed.length === 0) {
		return filePath => DEFAULT_TEST_PATTERNS.some(pattern => pattern.test(filePath));
	}
	const regex = globToRegex(trimmed);
	return filePath => regex.test(filePath);
}

/**
 * Test files that would break if `changedFiles` changed: BFS over files that
 * import the seeds (file-level `imports` edges plus imports of the seed's
 * exported symbols), up to `depth` hops; a seed that is already a test counts
 * directly. Stops early at {@link MAX_AFFECTED_FILES}.
 */
export function getAffectedTests(
	db: Database,
	changedFiles: readonly string[],
	options: { depth: number; isTestFile: (filePath: string) => boolean },
): AffectedResult {
	const { depth, isTestFile } = options;
	const tests = new Set<string>();
	// Counted across all seeds, matching the CLI's report line.
	const dependentsSeen = new Set<string>();
	let truncated = false;
	for (const file of changedFiles) {
		if (isTestFile(file)) {
			tests.add(file);
			continue;
		}
		const queue = [{ filePath: file, depth: 0 }];
		const visited = new Set([file]);
		let head = 0;
		while (head < queue.length && !truncated) {
			const current = queue[head++];
			if (current.depth >= depth) continue;
			for (const dependent of getFileDependents(db, current.filePath)) {
				if (visited.has(dependent)) continue;
				visited.add(dependent);
				dependentsSeen.add(dependent);
				if (isTestFile(dependent)) tests.add(dependent);
				else queue.push({ filePath: dependent, depth: current.depth + 1 });
				if (dependentsSeen.size >= MAX_AFFECTED_FILES) {
					truncated = true;
					break;
				}
			}
		}
	}
	return { tests: [...tests].sort(), traversed: dependentsSeen.size, truncated };
}

/** Files importing `filePath` — via its `file:` node and via imports of its exported symbols. */
function getFileDependents(db: Database, filePath: string): string[] {
	const nodes = queryRows<NodeRow>(db, `SELECT ${NODE_COLUMNS} FROM nodes WHERE file_path = ?`, filePath).map(toNode);
	const dependents = new Set<string>();
	const collectImporters = (nodeId: string): void => {
		const rows = queryRows<{ source: string }>(
			db,
			"SELECT source FROM edges WHERE target = ? AND kind = 'imports'",
			nodeId,
		);
		for (const source of fetchNodes(
			db,
			rows.map(row => row.source),
		).values()) {
			// A node importing its own file (re-exports, cycles) is not a dependent.
			if (source.filePath && source.filePath !== filePath) dependents.add(source.filePath);
		}
	};
	const fileNode = nodes.find(node => node.kind === "file");
	if (fileNode) collectImporters(fileNode.id);
	for (const node of nodes) {
		if (node.isExported) collectImporters(node.id);
	}
	return [...dependents];
}

// ---------------------------------------------------------------------------
// files: indexed-path listing with dir/glob filters.
// ---------------------------------------------------------------------------

/**
 * Indexed paths matching the optional `dir` (directory-boundary prefix),
 * `pattern` (glob, unanchored like the CLI's `--pattern`) and `maxDepth`
 * (separator count: `a.ts` 0, `dir/a.ts` 1 — the CLI's `--max-depth`),
 * sorted by path. The caller applies the output limit.
 */
export function listIndexedFiles(
	db: Database,
	options: { dir?: string; pattern?: string; maxDepth?: number },
): string[] {
	let paths = queryRows<{ path: string }>(db, "SELECT path FROM files ORDER BY path").map(row => row.path);
	const dir = options.dir?.trim().replace(/^\.\//, "").replace(/\/$/, "");
	if (dir !== undefined && dir.length > 0) {
		const prefix = `${dir}/`;
		paths = paths.filter(candidate => candidate === dir || candidate.startsWith(prefix));
	}
	const pattern = options.pattern?.trim();
	if (pattern !== undefined && pattern.length > 0) {
		const regex = globToRegex(pattern);
		paths = paths.filter(candidate => regex.test(candidate));
	}
	if (options.maxDepth !== undefined && Number.isFinite(options.maxDepth)) {
		const maxDepth = Math.max(0, Math.floor(options.maxDepth));
		paths = paths.filter(candidate => countDirSeparators(candidate) <= maxDepth);
	}
	return paths;
}

function countDirSeparators(filePath: string): number {
	return filePath.split("/").length - 1;
}

/** Glob -> regex as the CLI's `files --pattern` does: `**` spans separators, `*`/`?` do not, match is unanchored. */
function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "{{GLOBSTAR}}")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\{\{GLOBSTAR\}\}/g, ".*");
	return new RegExp(escaped);
}

// ---------------------------------------------------------------------------
// status: counts, journal mode, pending changes, worktree mismatch.
// ---------------------------------------------------------------------------

export async function getIndexStats(db: Database, indexRoot: string): Promise<IndexStats> {
	const totals = queryRow<{ files: number; nodes: number; edges: number }>(
		db,
		"SELECT (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges",
	);
	const nodesByKind = queryRows<{ kind: string; count: number }>(
		db,
		"SELECT kind, COUNT(*) AS count FROM nodes GROUP BY kind ORDER BY count DESC",
	);
	const filesByLanguage = queryRows<{ language: string; count: number }>(
		db,
		"SELECT language, COUNT(*) AS count FROM files GROUP BY language ORDER BY count DESC",
	);
	let dbBytes = 0;
	try {
		dbBytes = (await fs.promises.stat(codegraphDbPath(indexRoot))).size;
	} catch {
		// The index disappeared mid-call; the count fields still stand.
	}
	return {
		fileCount: totals?.files ?? 0,
		nodeCount: totals?.nodes ?? 0,
		edgeCount: totals?.edges ?? 0,
		nodesByKind,
		filesByLanguage,
		dbBytes,
	};
}

export function getJournalMode(db: Database): string {
	return queryRow<{ journal_mode: string }>(db, "PRAGMA journal_mode")?.journal_mode ?? "unknown";
}

/**
 * Files whose content differs from the index, or `null` outside a git checkout
 * (no fast path there; hashing every indexed file is not worth it for an
 * advisory panel — reported as "skipped" rather than "up to date").
 *
 * Two intentional deviations from the CLI: `untracked: "all"` reports files
 * inside a wholly-untracked directory instead of collapsing to the directory
 * name (which the source filter then drops), and NUL-terminated entries avoid
 * git's C-quoting so paths with spaces/quotes compare against the index.
 */
export async function computePendingChanges(
	db: Database,
	indexRoot: string,
	signal?: AbortSignal,
): Promise<PendingChanges | null> {
	const repo = vcs.git(indexRoot);
	if (!repo) return null;
	const porcelain = await repo.statusPorcelain({ untracked: "all", nulTerminated: true }, signal);
	const tokens = porcelain.split("\0");
	const added = new Set<string>();
	const modified = new Set<string>();
	const removed = new Set<string>();

	for (let index = 0; index < tokens.length; index++) {
		const entry = tokens[index];
		if (entry.length < 4) continue; // Minimum `XY path`
		const code = entry.slice(0, 2);
		const entryPath = normalizeIndexPath(entry.slice(3));
		// `-z` keeps the original path as the next token after a rename/copy
		// marker: `R` retires it (the CLI's `--no-renames` D+A pair), `C` keeps it.
		let originalPath: string | undefined;
		if (code.includes("R") || code.includes("C")) originalPath = normalizeIndexPath(tokens[++index] ?? "");
		if (originalPath && code.includes("R") && isSourceFile(originalPath)) removed.add(originalPath);
		if (!isSourceFile(entryPath)) continue;
		if (code === "??") added.add(entryPath);
		else if (code.includes("D")) removed.add(entryPath);
		else modified.add(entryPath);
	}

	const pendingAdded = new Set<string>();
	const pendingModified = new Set<string>();
	const pendingRemoved = new Set<string>();
	for (const candidate of [...added, ...modified]) {
		throwIfAborted(signal);
		const trackedHash = await indexedContentHash(db, candidate);
		if (trackedHash === undefined) {
			pendingAdded.add(candidate);
			continue;
		}
		const hash = await hashWorkingFile(path.join(indexRoot, candidate), signal);
		if (hash !== null && hash !== trackedHash) pendingModified.add(candidate);
	}
	for (const candidate of removed) {
		throwIfAborted(signal);
		if ((await indexedContentHash(db, candidate)) !== undefined) pendingRemoved.add(candidate);
	}

	return {
		added: [...pendingAdded].sort(),
		modified: [...pendingModified].sort(),
		removed: [...pendingRemoved].sort(),
	};
}

function normalizeIndexPath(rawPath: string): string {
	return rawPath.startsWith("./") ? rawPath.slice(2) : rawPath;
}

async function indexedContentHash(db: Database, filePath: string): Promise<string | undefined> {
	return queryRow<{ content_hash: string }>(db, "SELECT content_hash FROM files WHERE path = ?", filePath)
		?.content_hash;
}

/** sha256 of the working file (the encoding upstream hashes), or `null` when unreadable/vanished. */
async function hashWorkingFile(absolutePath: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const content = await Bun.file(absolutePath).text();
		throwIfAborted(signal);
		return new Bun.CryptoHasher("sha256").update(content).digest("hex");
	} catch (error) {
		if (isEnoent(error)) return null;
		if (error instanceof Error && error.name === "ToolAbortError") throw error;
		return null;
	}
}

/**
 * Warn when the query runs inside a git working tree nested under the tree the
 * index belongs to (a worktree created inside the main checkout walks up and
 * silently borrows the main tree's index — every answer would describe the
 * wrong branch). Mirrors upstream `detectWorktreeIndexMismatch`; only
 * reported by `status`.
 */
export async function detectIndexWorktreeMismatch(
	cwd: string,
	indexRoot: string,
): Promise<IndexWorktreeMismatch | null> {
	const cwdWorktreeRoot = await findRepoRoot(cwd);
	if (cwdWorktreeRoot === null) return null;
	const worktreeRoot = await realpathOrResolve(cwdWorktreeRoot);
	const resolvedIndexRoot = await realpathOrResolve(indexRoot);
	if (worktreeRoot === resolvedIndexRoot) return null;
	// An index in a plain ancestor (monorepo subdir, non-git dir) legitimately
	// belongs to this tree — only a working-tree *root* can be borrowed from.
	const indexWorktreeRoot = await findRepoRoot(resolvedIndexRoot);
	if (indexWorktreeRoot === null || (await realpathOrResolve(indexWorktreeRoot)) !== resolvedIndexRoot) return null;
	return { worktreeRoot, indexRoot: resolvedIndexRoot };
}

async function realpathOrResolve(target: string): Promise<string> {
	try {
		return await fs.promises.realpath(target);
	} catch {
		return path.resolve(target);
	}
}

// ---------------------------------------------------------------------------
// Path classifiers (ports of upstream extraction/grammars.js and
// extraction/generated-detection.js).
// ---------------------------------------------------------------------------

/** Extensions upstream `isSourceFile` indexes (file-level languages included); keys of its EXTENSION_MAP. */
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".jsx",
	".py",
	".pyw",
	".go",
	".rs",
	".java",
	".c",
	".h",
	".cpp",
	".cc",
	".cxx",
	".hpp",
	".hxx",
	".cs",
	".php",
	".module",
	".install",
	".theme",
	".inc",
	".yml",
	".yaml",
	".twig",
	".rb",
	".rake",
	".swift",
	".kt",
	".kts",
	".dart",
	".liquid",
	".svelte",
	".vue",
	".pas",
	".dpr",
	".dpk",
	".lpr",
	".dfm",
	".fmx",
	".scala",
	".sc",
	".lua",
	".luau",
	".m",
	".mm",
	".xml",
	".properties",
]);

/** Whether the index tracks this path — same single source of truth upstream uses before counting a change. */
export function isSourceFile(filePath: string): boolean {
	if (isPlayRoutesFile(filePath)) return true; // Play `conf/routes` is extensionless
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return false;
	return SOURCE_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

function isPlayRoutesFile(filePath: string): boolean {
	return filePath === "conf/routes" || filePath.endsWith("/conf/routes") || filePath.endsWith(".routes");
}

const GENERATED_PATTERNS = [
	// Go — protobuf / gRPC / pulsar / mockgen
	/\.pb\.go$/,
	/\.pulsar\.go$/,
	/_grpc\.pb\.go$/,
	/_mock\.go$/,
	/_mocks\.go$/,
	/^mock_[^/]+\.go$/,
	// TypeScript / JavaScript — Apollo/GraphQL codegen, Prisma, ts-proto, gRPC-web
	/\.generated\.[jt]sx?$/,
	/\.gen\.[jt]sx?$/,
	/\.pb\.[jt]s$/,
	/_pb\.[jt]s$/,
	/_grpc_pb\.[jt]s$/,
	// Python — protobuf / gRPC
	/_pb2(_grpc)?\.py$/,
	/_pb2\.pyi$/,
	// C++ / C# / Java — protobuf / gRPC
	/\.pb\.(cc|h)$/,
	/\.g\.cs$/,
	/Grpc\.cs$/,
	/OuterClass\.java$/,
	/Grpc\.java$/,
	// Swift / Dart — protobuf, build_runner, freezed, chopper
	/\.pb\.swift$/,
	/\.g\.dart$/,
	/\.freezed\.dart$/,
	/\.pb\.dart$/,
	/\.pbgrpc\.dart$/,
	/\.chopper\.dart$/,
	// Rust — build.rs outputs kept in-tree
	/\.generated\.rs$/,
];

/** Whether a path looks tool-generated — a ranking hint (demoted in `query` output), not a hard claim. */
export function isGeneratedFile(filePath: string): boolean {
	return GENERATED_PATTERNS.some(pattern => pattern.test(filePath));
}
