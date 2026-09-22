# feat(coding-agent): share MCP, embedder, and browser across omp processes

基线：fork/main `b672cf020c`    worktree：`.wt/session-daemon-1-heavy`    分支：`feat/session-daemon-heavy-workers`
关联：无 issue。前置：`todo/handoff/session-daemon-0-heap-baseline.md` 的回执判定不是「停」。本阶段不把会话搬进 daemon。客户端仍是完整 omp 进程，只把三块重资源交给已经存在的 broker。

## 0 出发前：基线与禁区

- 基线：`b672cf020c`。
- worktree：`git worktree add .wt/session-daemon-1-heavy -b feat/session-daemon-heavy-workers b672cf020c`。禁止在根工作树改文件。
- 图：已在 `main` 的 `b672cf020c` 刷新。开工时 `cg status` 必须仍指向该基线，否则先 `cg refresh`。
- 禁改区：`.githooks/`、`packages/catalog/src/models.json`、`AgentSession` 的对话循环、TUI 渲染。

## 1 在什么地方

- `packages/coding-agent/src/launch/broker.ts`    改：在现有 `ManagedDaemon` 之外登记三类共享所有者：MCP、embedder、browser。复用 lease、socket、idle grace，不新起一套进程模型。
- `packages/coding-agent/src/launch/protocol.ts`    改：加这三类的 request/snapshot 类型。
- `packages/coding-agent/src/launch/client.ts`    改：客户端按 project dir 拿到这三类的句柄。
- `packages/coding-agent/src/mcp/manager.ts`    改：保留 `MCPManager` 对外能力，把进程所有权和 transport 下沉为 broker-backed client。
- `packages/coding-agent/src/mcp/loader.ts`、`packages/coding-agent/src/sdk.ts`、`packages/coding-agent/src/modes/acp/acp-agent.ts`、`packages/coding-agent/src/modes/controllers/mcp-command-controller.ts`、`packages/coding-agent/src/slash-commands/helpers/mcp.ts`    改或确认不改：这些是真实的 `new MCPManager(...)` 调用点；逐个切到同一个 broker-backed 构造路径，禁止遗漏临时 manager 和 ACP 路径。
- `packages/coding-agent/src/mnemopi/embed-client.ts`    改：`MNEMOPI_EMBED_WORKER_ARG` 子进程改由 broker 持有，客户端只发 embed 请求。
- `packages/coding-agent/src/tools/browser/registry.ts`、`packages/coding-agent/src/tools/browser.ts`、`packages/coding-agent/src/tools/read-pdf.ts`、`packages/coding-agent/src/web/search/providers/browser-page.ts`    改或确认不改：graph 只识别到 `browser.ts` 的直接边，grep 另确认 `read-pdf.ts` 和 `browser-page.ts` 也直接调用 `acquireBrowser`；所有路径必须获得相同的 broker ownership 语义。
- `packages/coding-agent/src/tools/browser/shared-daemon.ts`    复用：该文件已通过 `daemonClientForProject` 连接 broker，优先扩展现有协议，不再造第二套 browser daemon。
- `packages/coding-agent/test/launch/shared-heavy-workers.test.ts`    新建：两个客户端附着同一 MCP、embedder 和 browser pid。
- 不动：`packages/coding-agent/src/session/agent-session.ts` 的 turn 循环、`packages/tui/**`、`DaemonBroker` 现有的 dev-server/PTY 监督语义。

## 2 参考什么内容，技术栈，思路

子代理先调查，回执写路径和行号。

- 参考实现：
  - `packages/coding-agent/src/launch/broker.ts` `class DaemonBroker`：`#records`、`acquireBrokerLease`、idle timer、`net.Server`。socket 规则在 `launch/paths.ts` `daemonBrokerEndpoint`：Unix 是 `<runtimeDir>/broker.sock`，按 canonical project dir 分 scope。
  - `packages/coding-agent/src/launch/client.ts` `daemonClientForProject`：已有「没有 broker 就拉起，有就连接」。
  - jcode 只借生命周期，不借代码：`jcode` `crates/jcode-app-core/src/server/socket.rs` 的 flock + stale socket reap + ready-fd。omp 已经有 `FileLock` lease 和 `LEASE_HANDOFF_GRACE_MS`，不要再移植一套。
  - embedder 现状：`mnemopi/embed-worker.ts` 是每个父进程一个 `__omp_worker_mnemopi_embed`。browser 现状：`tools/browser/registry.ts` `acquireBrowser` 在调用进程里起 Chromium。
- 技术栈：Bun + 现有 `node:net` + `@oh-my-pi/pi-natives` `FileLock`。禁止新依赖。禁止共享 JS 堆的方案（`SharedArrayBuffer` 装不下 `MCPManager`）。
- 调用面已用当前 graph + grep 预查：
  - `acquireBrowser` 的 graph 结果包含 `tools/browser.ts` 与既有 lifecycle tests；grep 补出 `tools/read-pdf.ts`、`web/search/providers/browser-page.ts`。
  - `new MCPManager(...)` 实际存在于 `mcp/loader.ts`、`mcp/manager.ts`、`modes/acp/acp-agent.ts`、`mcp-command-controller.ts`、`sdk.ts`、`slash-commands/helpers/mcp.ts`。
  - `daemonClientForProject(...)` 已被 blob broker、LSP mux、browser shared daemon、hub launch、`omp ps` 使用；这些调用保持原语义。图未索引该函数，故以上边由 grep 确认。
  - 开工时仍须对 qualified `MCPManager`、`acquireBrowser` 跑 `cg callers`，并逐行 grep 复核。
- 思路：broker 进程持有子进程，客户端持有 RPC 句柄。第二个 omp 启动时连接同一个 project socket，发现 MCP server / embed worker / browser 已在，就附着，不 spawn。最后一个客户端断开后沿用 broker 现有 idle grace，到期杀掉这三类子进程。

不选的做法：把三个子进程做成全局单例。MCP 和 browser 带项目目录与登录态，必须跟现有 broker 一样按 project dir 分 scope。

## 3 实现什么功能

行为，不写内部结构：

- 同一 project dir 的两个 omp，对同一个 MCP server id，只存在一个 server 子进程。第二个客户端的 tool call 打到这个进程。
- 同一 project dir 的 embed 请求进同一个 `__omp_worker_mnemopi_embed`。第一个客户端退出后，第二个的 embed 仍成功。
- 同一 project dir、同一 browser profile，只存在一个 Chromium pid。第二个 `acquireBrowser` 返回的 handle 操作这个 pid。
- 两个客户端都退出后，idle grace 到期，这三类子进程退出，broker 按现有规则退出。
- 不同 project dir 互不影响：各有各的 socket 和子进程。
- broker 崩溃：客户端下一次调用重新 `ensure`，可以再拉起；进行中的 tool call 失败并返回可重试错误，不挂死。

边界：

- 空：没有 MCP 配置的项目不 spawn server。
- 并发：两个客户端同时第一次请求，只 spawn 一个。用 broker 里已有的 `#startingNames` 同类预约，不要各写一把锁。
- 失败重入：spawn 失败记在 broker，客户端看到错误；下一次请求允许再试，不永久占着「正在启动」。

不做：不搬 `AgentSession`，不让 TUI 变成瘦客户端，不共享 settings / model registry / 对话记录。那是阶段 2。

## 4 补充什么测试

位置：`packages/coding-agent/test/launch/shared-heavy-workers.test.ts`。

- `second client attaches to the running mcp server`：哪种 bug 会红——第二个客户端又 spawn 了一个 server pid。
- `embed survives the first client exiting`：哪种 bug 会红——embed worker 被父进程生命周期绑死，父退出后 worker 被杀。
- `two projects do not share a browser`：哪种 bug 会红——scope 做成了机器全局，另一个目录的 omp 附着到了这个 Chromium。
- `in-flight call fails retryably when the broker dies`：哪种 bug 会红——broker 消失后调用一直挂到超时，或被吞成空结果。

不写：不测 broker 内部字段名，不测 socket 路径字符串，不给 `DaemonBroker` 现有 PTY 行为再加一轮重复测试。

## 5 验收条件(必须标 commit)

本地只跑跟改动直接相关的测试文件，不跑全量。

- [ ] `bun test packages/coding-agent/test/launch/shared-heavy-workers.test.ts` 通过 — `<SHA>`
- [ ] `git diff --name-only b672cf020c..HEAD` 只有 §1 白名单 — `<SHA>`
- [ ] 两个手动 omp 的 MCP server pid 相同，命令和输出在 §6 — `<SHA>`
- [ ] `cg changes b672cf020c` 非 critical — 回执写实际 risk

## 6 模拟测试功能(smoke)

- cwd：worktree 根。
- 起 broker 所在项目里的两个 omp（两个终端）。对同一个已配置 MCP tool 各调一次。
- 观察：`pgrep -af <该 mcp server 的命令>` 只有一个 pid；两个客户端都收到工具结果。
- 关掉第一个终端，第二个再 embed 一次，仍有结果。
- 两个都关掉，等 idle grace，`pgrep` 不再有这个 server / embed worker / 本次 browser pid。
- 记录三条命令的 stdout。对不上就写实际现象，不要写成通过。

## 7 清理什么

- [ ] 一次性复现脚本已删
- [ ] 本次新增的未用 import 已清
- [ ] 不留「旧的每进程 spawn」开关。迁移后的调用点只有 broker 路径
- [ ] 不改用户文档，除非 `omp ps` 的输出新增了这三类进程；若新增，改对应 command help

## 8 禁止项

- 禁止改 §1 以外的文件
- 禁止新依赖
- 禁止 `git add .`
- 禁止在根工作树开发
- 禁止把 `AgentSession` 塞进 `DaemonBroker.#records`
- 禁止为了共享把 MCP 从 project scope 改成机器全局
- 禁止顺手重构 PTY 监督路径

## 9 并发边界

单子代理。`broker.ts`、`protocol.ts`、`client.ts` 只有这一个主人。不与阶段 2 并行，阶段 2 会改同一批 launch 文件。

## 10 交接

未开工。阶段 0 回执里的「MCP / embedder / browser MB」决定本阶段值不值得做。低于 30MB 就停，在回执写明，不改代码。
