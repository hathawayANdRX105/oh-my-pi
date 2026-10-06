Structural queries over the local codegraph index (`.codegraph/`): symbol search, callers/callees, change impact, affected tests, indexed files, sync. Index-relative paths — same root the index was built at.

<instruction>
Select via `action`.
- `query`: `symbol` = name or text; ranked rows `kind qualified.name — path:line` (+ signature). Narrow with `kind` (function/method/class/interface/…); `limit` default 10.
- `callers`/`callees`: `symbol` required; resolves exact names, prefix hits only when unambiguous; `limit` default 20.
- `impact`: `symbol` required — everything that depends on it, `depth` 1-10 (default 2). Run before refactoring to see blast radius; container members (class → its methods) count at the same depth.
- `affected`: `files` required — test files importing those paths, `depth` default 5; `testFilter` glob replaces the default test patterns; a changed test file counts itself.
- `files`: browse indexed paths; `dir` matches directory boundaries (`"src"` excludes `srcfoo.ts`), `pattern` glob, `format` `flat`|`tree`|`grouped`, `maxDepth`, `limit` default 200.
- `status`: counts, journal, pending changes vs the working tree, worktree mismatch.
- `sync`: re-index through the `codegraph` CLI — the only action that spawns a process.
</instruction>

<output>
One row per result (`kind qualified.name — path:line`); `files` lists paths. Empty result = marked useless: the index has no such symbol/edge, not a failed call.
</output>

<critical>
The index lags the working tree — after big edits run `status` (pending changes) or `sync`, never treat a miss as proof of absence on a stale index. For text/content search, line matches, gitignore-aware scans, or files outside the index use `grep`/`glob`; codegraph answers structure, not content.
</critical>
