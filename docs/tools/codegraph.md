# codegraph

> Structural queries over a local codegraph index (`.codegraph/codegraph.db`, written by the external `codegraph` CLI): symbol search, callers/callees, change impact, affected tests, indexed-file listings, index status, and re-sync. Shown as `Codegraph` in the UI.

## Source
- Entry: `packages/coding-agent/src/tools/codegraph/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/codegraph/queries.ts` — read-only SQL layer: ranking (FTS → LIKE → exact supplement → rescore), reverse-BFS impact, dependent-file BFS, pending-change diff against git, index stats.
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — shared read-only opener (`query_only`, busy timeout, WAL sidecar init).
  - `packages/coding-agent/src/exec/exec.ts` — `execCommand`, used only by `action: "sync"` (`codegraph sync -q`).
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — `codegraph` timeout entry (sync ceiling).
  - `packages/coding-agent/src/capability/fs.ts` — `findRepoRoot`, used to detect a worktree/index-root mismatch.
  - `packages/coding-agent/src/tools/settings.ts` — `codegraph.enabled` gate.

The query semantics mirror the upstream `codegraph` CLI (`query|callers|callees|impact|affected|files|status`) so a tool answer agrees with one obtained from the shell.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `"status" \| "query" \| "callers" \| "callees" \| "impact" \| "affected" \| "files" \| "sync"` | Yes | Operation. Everything but `sync` reads the index in-process. |
| `symbol` | `string` | For `query`, `callers`, `callees`, `impact` | Symbol name (relations/impact) or search text (`query`). Whitespace-only is rejected. |
| `files` | `string[]` | For `affected` | Changed file paths; rebased onto the index root (cwd-relative, `./`-relative, and absolute paths under the index root all work). |
| `kind` | `string` | No | Restrict `query` results to one node kind (`function`, `method`, `class`, `interface`, `trait`, …), matched case-insensitively. |
| `limit` | `number` | No | Max rows. Defaults: `query` 10, `callers`/`callees` 20, `impact`/`affected`/`files` 200; clamped to 100 (relations/query) or 1000 (the rest). |
| `depth` | `number` | No | `impact`: reverse hops, default 2, clamped 1–10. `affected`: dependent-file hops, default 5, floored at 1. |
| `testFilter` | `string` | No | Glob selecting test files for `affected`; replaces the default patterns (`*.spec.*`, `*.test.*`, `/tests/`, `/__tests__/`, `/e2e/`, `/spec/`) wholesale. |
| `dir` | `string` | No | `files` directory scope, matched on directory boundaries (`"src"` never matches `srcfoo.ts`). Index-root-relative. |
| `pattern` | `string` | No | `files` glob over index-root paths (`**` spans separators, match is unanchored, like the CLI's `--pattern`). |
| `format` | `"flat" \| "tree" \| "grouped"` | No | `files` layout; default `grouped` (prefix-folded `# dir/` headers, the glob tool's shape). `tree` renders box connectors; `flat` prints one full path per line. |
| `maxDepth` | `number` | No | `files` directory depth in separators: `a.ts` is 0, `dir/a.ts` is 1. |

`codegraph.enabled` is `auto` by default: the tool is enabled only when a `.codegraph/codegraph.db` exists at or above the session cwd (checked fresh on every evaluation, never cached). `on` enables it regardless (calls then error with setup guidance when no index exists); `off` disables it. Once enabled it is a `discoverable`, read-tier tool that stays top-level under xdev (the grep/find/glob/bash prompts redirect to it by name).

## Outputs
- Single text block. One row per result: `kind qualified.name — path:line`; `query` rows append the (single-line, tab-flattened, 100-column-truncated) signature after `·`.
- `status`: worktree-mismatch warning when present, index path + journal mode, `files · nodes · edges · DB size`, top node kinds, languages, and pending changes (`N modified, N added, N removed` with up to 10 `M`/`A`/`D` paths), or `skipped (not a git checkout)` / `none`.
- `callers`/`callees`: header `Callers of <resolved target>` — when several symbols match, `Callers of N symbols matching "…"` plus up to five resolved-target lines; rows are the deduplicated union across targets.
- `impact`: header carries the depth and truncated walks add a node-ceiling note.
- `affected`: header carries seeds, depth, and dependents walked.
- Empty result sets are marked `useless` (except `status`/`sync`) with a per-action message; an `affected` walk that hit its file ceiling reports "incomplete" rather than claiming absence.
- `details`: `action`, `indexRoot` (`status`/`sync`), `symbol` (query/relations/impact), `resultCount`, and `meta` (result-limit notices with the suggestion capped at the action's ceiling).
- `sync`: `Synced in <duration>` plus post-sync counts.

## Flow
1. **Gate + locate.** `sync` resolves the `codegraph` CLI (`$which`, fresh cache); every action walks up from the session cwd for the directory owning `.codegraph/codegraph.db` and errors with setup guidance when none exists.
2. **Open.** `openCodegraphIndex` opens the DB read-only through `sqlite-reader` and pins `schema_versions` to v4 — a newer/foreign file is a `ToolError`, never a wrong-shaped answer.
3. **Dispatch.** `status` (counts + `git status --porcelain -z` diff + worktree check), `query` (BM25 FTS → LIKE tier → exact-name supplement → kind/path/name rescore, generated files demoted below hand-written hits), `callers`/`callees` (exact-name target resolution — prefix hits only when unambiguous — then incoming/outgoing `calls|references|imports` edges), `impact` (reverse BFS with same-depth container expansion), `affected` (dependent-file BFS via `file:`-node and exported-symbol `imports` edges until test files match), `files` (path listing with `dir`/`pattern`/`maxDepth` filters).
4. **`sync`.** `codegraph sync -q` with cwd = index root, bounded by the `codegraph` timeout (`tools.maxTimeout` may lower it); on success the index is re-opened to report fresh counts.

## Side Effects
- Reads: opens the index read-only (`query_only`); `status` additionally runs `git status` porcelain and sha256-hashes the changed working files to diff them against `files.content_hash`.
- Network: none.
- Process: only `action: "sync"` spawns the `codegraph` CLI.
- Cancellation: the abort signal is honored between query phases, inside the pending-change hashing loop, and by the sync subprocess.

## Limits & Caps
- `limit` defaults/ceilings: `query` 10/100, `callers`/`callees` 20/100, `impact` 200/1000, `affected` 200/1000, `files` 200/1000. The capped-suggestion notice never advises past the ceiling.
- `impact` depth 1–10; traversal stops at 5000 nodes and says so.
- `affected` stops at 2000 dependent files and says so.
- `resolveSymbolTargets` considers at most 50 search candidates; `status` lists at most 10 pending paths; signatures truncate at 100 columns (`TRUNCATE_LENGTHS.LONG`).
- Sync timeout: 120 s default (5–3600 s, `codegraph` entry in `tool-timeouts.ts`).

## Errors
- `No .codegraph index found above <cwd>. Build one with \`codegraph init -i\` …` — no index at/above the cwd (also the `sync` variant, which additionally asks for `init` first).
- `Codegraph index schema is vN but this build reads v4 …` / `not a codegraph index …` — schema guard on open; rebuild guidance included.
- `` `symbol` is required for action "…" `` / `` `files` is required for action "affected" `` — missing required field.
- `` `codegraph` CLI not on PATH `` / `codegraph sync failed (exit N): …` / `codegraph sync timed out after Ns` — sync-side failures; a caller abort surfaces as the standard abort error.

## Notes
- Deliberate divergences from the CLI, each noted in `queries.ts`: no fuzzy (edit-distance) fallback tier — a near-miss says "not found" so the model corrects and retries; `dir` matches directory boundaries instead of naive prefixes; an exact target with **no** callers stays empty instead of falling back to another symbol's callers; traversal is capped; pending changes report `untracked: "all"` with NUL-terminated porcelain.
- The index lags the working tree — `status`/`sync` exist to surface that, and the prompt instructs treating a miss on a stale index as unproven.
- `files` paths and the `dir`/`pattern` filters are index-root-relative (the root the index was built at), which may be an ancestor of the session cwd in a subdirectory session.
