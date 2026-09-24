# chore(coding-agent): measure what one omp process actually keeps resident

基线：fork/main `b672cf020c`    worktree：`.wt/session-daemon-0-heap`    分支：`chore/session-daemon-heap-baseline`
关联：无 issue。用户设想：N 个 omp 客户端共用一个 200–300MB 运行时，只为每个会话另付会话状态。本阶段不实现 daemon，只回答这个设想省的是不是运行时。

## 0 出发前：基线与禁区

- 基线：`b672cf020c`（三阶段任务书已经进入 fork/main）。
- worktree：`git worktree add .wt/session-daemon-0-heap -b chore/session-daemon-heap-baseline b672cf020c`。禁止在根工作树改文件。
- 图：已在 `main` 的 `b672cf020c` 执行 `cg refresh`；图包含 55297 nodes、585312 edges、3574 files。开工时仍须 `cg status`，若 commit 不一致先 refresh。
- 禁改区：`.githooks/`、`packages/catalog/src/models.json`、任何会话/TUI/broker 实现。

## 1 在什么地方

- `todo/handoff/session-daemon-0-heap-baseline.md`    改：把测量结果填进文末「测量回执」
- `.wt/session-daemon-0-heap/scripts/heap-baseline.ts`    新建，worktree 内一次性脚本，跑完删除，不进提交
- 不动：`packages/coding-agent/src/**`、`packages/agent/**`、`packages/ai/**`

本阶段的产物是数字，不是代码。

## 2 参考什么内容，技术栈，思路

子代理先核对，再量。

- 参考实现：
  - 进程入口 `packages/coding-agent/src/cli.ts` `runCli()`：一次调用一个进程，worker 通过 `__omp_worker_*` 另起进程，不是会话宿主。
  - 装配 `packages/coding-agent/src/sdk.ts` `createAgentSession`：`modelRegistry`、`authStorage`、`settings`、`sessionManager`、`mcpManager`、`agentRegistry` 都在这次调用里建。
  - 会话体 `packages/coding-agent/src/session/agent-session.ts` `AgentSession`：`main` 上该文件 469320 字节。
  - 已有 daemon：`packages/coding-agent/src/launch/broker.ts` `DaemonBroker`。按项目一个 socket（`launch/paths.ts` `daemonBrokerEndpoint`），监督的是 `ManagedDaemon` 子进程，不是 `AgentSession`。
- 技术栈：Bun。`Bun.generateHeapSnapshot()` 或 `process.memoryUsage()`。禁止加依赖。禁止为了测量去改运行时。
- 调用面：不改符号，无 `cg callers` 义务。
- 已核实调用面：本阶段不改符号。`cg callers setProjectDir` 当前返回 50 个结果，其中生产调用集中在 `startup-cwd.ts`、`main.ts`、`interactive-mode.ts`、`builtin-lifecycle.ts`，其余大部分为测试；这些只作为阶段 2 的基线，不在本阶段修改。
- 思路：同一台机器上起两个进程。A 是刚启动、空会话。B 是打开一个已知的长会话（journal 大、工具调用多）。对 A、B 各取 RSS 和 heap snapshot，按 retainer 归成四桶：运行时/模块图、模型与 prompt 静态数据、MCP 与 embedder 与 browser、会话对象（消息、journal 索引、工具状态）。A 与 B 的差就是会话可变成本。A 本身才是「每多一个客户端就要再付的运行时」。

不选的做法：用现在机器上那 7 个 omp 的 RSS（当时约 168–267MB）当结论。那些进程混着会话、子 agent 和编译缓存，拆不开。

## 3 实现什么功能

没有新的公开签名。要交出的观察：

- 空进程 RSS、heap used。
- 长会话进程 RSS、heap used。
- 四桶各占多少 MB，以及 A→B 的增量落在哪一桶。
- 一句判定：若 A 的可共享部分（运行时 + 静态数据 + 可上收的 MCP/embedder/browser）小于 80MB，阶段 2 不值得做，阶段 1 单独评估。若大于 150MB，阶段 2 有账可算。80–150MB 之间，只做阶段 1。

边界：测量时不要开新的 MCP、不要让 embedder 在 A 里预热。B 用一个已经存在的会话文件，路径写进回执。会话文件不存在就停，不要现造一个长会话冒充。

不做：不实现共享、不改 daemon、不写永久测试。

## 4 补充什么测试

无。一次性脚本跑完删除。给脚本留测试是废测试。

## 5 验收条件(必须标 commit)

本阶段默认零代码 commit。验收是回执里的数字：

- [ ] 空进程与长会话进程各有一条：命令、cwd、RSS、`heapUsed` — 无 SHA，附原始输出
- [ ] 四桶各有 MB 数，桶的归类规则写明（哪些 constructor / 路径算进哪桶）
- [ ] 判定句三选一：停 / 只做阶段 1 / 进入阶段 2
- [ ] worktree 内脚本已删，`git status` 干净

## 6 模拟测试功能(smoke)

这就是 smoke。

- 做法：worktree 里 `bun packages/coding-agent/src/cli.ts` 起空会话；另一个进程 `--resume <已有会话文件>`。
- 记录：命令、cwd、两个 PID 的 RSS（`ps -o pid,rss,args`）、heap snapshot 摘要。
- 做不到：会话文件缺失，或 snapshot API 在当前 Bun 上不可用。写明原因，改用 `process.memoryUsage()` 加 RSS，并注明这组数字不能分桶，判定降级为「证据不足，不进入阶段 2」。

## 7 清理什么

- [ ] `.wt/session-daemon-0-heap/scripts/heap-baseline.ts` 已删
- [ ] worktree 保留到用户确认数字；确认后 `git worktree remove`
- [ ] 不改 ROADMAP、不改实现

## 8 禁止项

- 禁止改 `packages/**`
- 禁止新增依赖
- 禁止 `git add .`
- 禁止在根工作树开发
- 禁止把 RSS 差值直接叫做「可共享运行时」
- 禁止为了得到漂亮数字去预热 embedder 或 MCP

## 9 并发边界

单人。不与阶段 1、阶段 2 并行。阶段 1 开工前必须有本回执。

## 测量回执

| 项 | 值 |
|---|---|
| 空进程命令 / cwd / PID / RSS / heapUsed | `bun scripts/heap-baseline.ts empty`；cwd `/home/hathaway/projects/oh-my-pi/.wt/session-daemon`；PID `2563193`；RSS `265134080` B（252.85 MiB）；heapUsed `50703325` B（48.35 MiB） |
| 长会话命令 / 会话文件 / PID / RSS / heapUsed | `bun scripts/heap-baseline.ts resume /home/hathaway/.omp/agent/sessions/-projects-ferrite/2026-09-06T08-59-02-163Z_01a075f1-4893-728e-8e8f-5763e1047e17.jsonl`；PID `2564366`；RSS `328622080` B（313.40 MiB）；heapUsed `97155811` B（92.66 MiB） |
| 运行时与模块图 MB | 空 `45.51` MiB；长会话 `47.59` MiB；增量 `2.08` MiB |
| 模型与 prompt 静态数据 MB | 空 `0.62` MiB；长会话 `2.89` MiB；增量 `2.27` MiB |
| MCP / embedder / browser MB | 空 `0.13` MiB；长会话 `0.31` MiB；增量 `0.18` MiB。测量显式禁用 MCP、LSP、IRC 和 Python preflight，未预热 embedder/browser |
| 会话对象 MB | 空 `0.94` MiB；长会话 `3.35` MiB；增量 `2.41` MiB |
| 判定 | **只做阶段 1**。空进程可识别共享桶合计 `46.26` MiB，低于 `80` MiB 门槛；不进入阶段 2 |
| 脚本已删 | 是；一次性测量脚本、临时 native 链接和 heap snapshots 均已删除 |

分类规则：按 V8 snapshot 节点的 `type:name` 对 `self_size` 求和。`code`、module record/environment、source/code block、structure、symbol table 归运行时；名称含 model、prompt、catalog、provider、tokenizer、schema 归静态数据；名称含 MCP、embedder、browser、Chromium、Puppeteer、Playwright 归重资源；名称含 session、message、journal、artifact、tool call/result、conversation、transcript、history、usage 归会话对象。

限制：这是名称启发式的 `self_size` 分类，不是 dominator retained-size 分析。空 snapshot 另有 `13.18` MiB、长会话 snapshot 另有 `46.64` MiB 无法可靠归桶；RSS 还包含 native、allocator、mmap 和 JIT 等 snapshot 外内存。因此不把 `60.55` MiB RSS 增量称为会话成本，也不把未分类内存算入可共享运行时。保守判定只使用可识别的空进程共享桶。

原始输出：

```json
{"mode":"empty","pid":2563193,"cwd":"/home/hathaway/projects/oh-my-pi/.wt/session-daemon","sessionPath":null,"rss":265134080,"heapUsed":50703325,"heapTotal":41730048,"external":19967645,"snapshotPath":"/tmp/omp-heap-empty-2563193.heapsnapshot"}
{"mode":"resume","pid":2564366,"cwd":"/home/hathaway/projects/oh-my-pi/.wt/session-daemon","sessionPath":"/home/hathaway/.omp/agent/sessions/-projects-ferrite/2026-09-06T08-59-02-163Z_01a075f1-4893-728e-8e8f-5763e1047e17.jsonl","rss":328622080,"heapUsed":97155811,"heapTotal":53036032,"external":53405795,"snapshotPath":"/tmp/omp-heap-resume-2564366.heapsnapshot"}
```
