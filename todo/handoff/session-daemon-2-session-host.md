# feat(coding-agent): host many sessions in one broker process

基线：fork/main `b672cf020c`    worktree：`.wt/session-daemon-2-host`    分支：`feat/session-daemon-host`
关联：无 issue。前置：阶段 0 判定「进入阶段 2」，且阶段 1 已合并或明确放弃。本阶段才是用户要的模型：一个进程付运行时，每个客户端只付自己的会话。

## 0 出发前：基线与禁区

- 基线：阶段 1 的合并提交；阶段 1 放弃时从 `b672cf020c` 起。任务书开工时把实际 SHA 填进本行，不许写「最新」。
- worktree：`git worktree add .wt/session-daemon-2-host -b feat/session-daemon-host <基线SHA>`。禁止在根工作树改文件。
- 图：当前调查已在 `main` 的 `b672cf020c` 完成；worktree 开工后再次 `cg refresh`，graph commit 必须等于实际基线。
- 禁改区：`.githooks/`、`packages/catalog/src/models.json`、jcode 仓库、`DaemonBroker` 的 PTY/dev-server 监督。

## 1 在什么地方

- `packages/coding-agent/src/launch/session-host.ts`    新建：一个进程里的 `Map<sessionId, SessionSlot>`。slot 持有该会话的 `AgentSession`、cwd、取消控制器。
- `packages/coding-agent/src/launch/session-protocol.ts`    新建：客户端与 host 的消息。最小集：`attach`、`resume`、`prompt`、`event`、`cancel`、`detach`。
- `packages/coding-agent/src/launch/broker.ts`    改：同一 project socket 上多路复用 session host。不把会话塞进 `ManagedDaemon`。
- `packages/coding-agent/src/launch/client.ts`    改：交互进程变成客户端。它画 TUI，把 prompt 发到 host，把 host 的 event 画出来。
- `packages/coding-agent/src/cli/startup-cwd.ts`、`packages/coding-agent/src/main.ts`、`packages/coding-agent/src/modes/interactive-mode.ts`、`packages/coding-agent/src/slash-commands/builtin-lifecycle.ts`、`packages/utils/src/dirs.ts`    改：拆开「CLI 客户端 cwd」与「host 内 SessionSlot cwd」。host 禁止调用会执行 `process.chdir()` 的 `setProjectDir()`。
- `packages/coding-agent/src/sdk.ts`    改：`createAgentSession` 已支持注入 `agentRegistry`，host 必须为每个 root slot 传独立 registry、cwd/sessionManager/settings/eventBus；外部 SDK 默认仍保持 in-process，不被透明重定向到 daemon。
- `packages/coding-agent/src/config/settings.ts`    改：host 上的 settings 按 project/session 注入，不允许 slot 通过模块级 Proxy 改写另一个 slot。
- `packages/coding-agent/src/registry/agent-registry.ts`、`packages/coding-agent/src/registry/agent-lifecycle.ts`    改：每个 root slot 有自己的 registry 和 lifecycle，不能共享唯一 `MAIN_AGENT_ID = "Main"`。
- `packages/coding-agent/src/collab/host.ts`、`packages/coding-agent/src/internal-urls/agent-protocol.ts`、`packages/coding-agent/src/internal-urls/history-protocol.ts`、`packages/coding-agent/src/internal-urls/issue-pr-protocol.ts`、`packages/coding-agent/src/internal-urls/local-protocol.ts`、`packages/coding-agent/src/internal-urls/memory-protocol.ts`、`packages/coding-agent/src/internal-urls/registry-helpers.ts`、`packages/coding-agent/src/irc/bus.ts`、`packages/coding-agent/src/session/irc-bridge.ts`    改：这些文件直接读取 `AgentRegistry.global()`；必须从当前 slot 的 resolve/runtime context 获得 registry，否则会跨会话读错 agent、history、memory、cwd 或 artifact。
- `packages/coding-agent/src/modes/agent-hub-runtime.ts`、`packages/coding-agent/src/modes/controllers/input-controller.ts`、`packages/coding-agent/src/modes/controllers/session-focus-controller.ts`、`packages/coding-agent/src/modes/controllers/tan-command-controller.ts`、`packages/coding-agent/src/task/executor.ts`、`packages/coding-agent/src/task/index.ts`、`packages/coding-agent/src/task/isolation-runner.ts`、`packages/coding-agent/src/task/persisted-revive.ts`    改：subagent、revive、task history 和 UI focus 全部使用所属 root slot 的 registry/lifecycle，不再回退到进程全局。
- `packages/coding-agent/src/commit/agentic/agent.ts`    核对：它是 `createAgentSession` 的生产调用者；若由 host session 触发则继承当前 slot registry，独立 CLI commit agent 保持 in-process。
- `packages/coding-agent/test/launch/session-host.test.ts`    新建。
- 不动：阶段 1 的 MCP/embedder/browser 所有权；`packages/tui/**` 的渲染原语（客户端继续用，不把 TUI 搬进 host）；jcode 的任何文件。

`agent-session.ts` 有 469320 字节。默认不拆文件，但不能假定它完全无需改：若方法直接读取 `process.cwd()`、`process.stdout`、模块级 settings 或 global registry，改成从既有 session/runtime context 注入。每个改动点必须在 §2 回执列出 caller 和原因。

## 2 参考什么内容，技术栈，思路

子代理先调查再改。回执必须有行号。

- 参考实现：
  - omp 已有的「一个进程多个 agent」是同一次调用里的 subagent：`registry/agent-registry.ts` 和 `registry/agent-lifecycle.ts`。当前代码已允许 `createAgentSession({ agentRegistry })` 注入私有 registry，但大量协议、任务和 UI 路径仍直接调用 `AgentRegistry.global()`；这些不是可延期项，否则两个 root session 会互相看见 agent、history、memory 与 artifact。
  - 装配缝：`sdk.ts` `createAgentSession`。graph 找到 95 个 caller 结果；生产调用至少包含 `commit/agentic/agent.ts`、`task/executor.ts`、`task/persisted-revive.ts`、`modes/controllers/tan-command-controller.ts`，以及 `main.ts` 中的 CLI/ACP factory。host 只接管 CLI/TUI/ACP root session；SDK examples、benchmark 和第三方嵌入保持 in-process。
  - broker 传输：`launch/broker.ts` 的 `net.Server`、token、lease。session 消息走这条已经认证的连接，不新开端口。
  - jcode 对得上的行为，只抄行为不抄 Rust：
    - `crates/jcode-app-core/src/server.rs` `sessions: Arc<RwLock<HashMap<String, Arc<Mutex<Agent>>>>>`：一个进程多会话。
    - `server/client_session.rs` `handle_resume_session`：按 id 挂回。
    - `server/client_disconnect_cleanup.rs`：最后一个客户端离开才从内存卸掉，磁盘保留。
    - `server.rs` idle 退出码 44，reload 用 exec 交接后从磁盘恢复。
  - omp 会话磁盘格式已经存在：`session/session-storage.ts` `FileSessionStorage` 的 JSONL journal。resume 读它，不发明第二种会话文件。
- 技术栈：Bun，一个 host 进程。禁止 `SharedArrayBuffer`、禁止按会话 `fork()`、禁止新依赖。Bun 进程之间不共享堆，所以「共享内存」在这里就是「同一个进程」。
- 调用面已在 `b672cf020c` 用 graph + grep 核实：
  - `cg callers setProjectDir` 返回 50 个结果。生产调用落在 `cli/startup-cwd.ts`、`main.ts`、`modes/interactive-mode.ts`、`slash-commands/builtin-lifecycle.ts`；其余大部分为测试。`packages/utils/src/dirs.ts:setProjectDir` 在第 223 行直接 `process.chdir(resolved)`。
  - qualified `sdk.ts::createAgentSession` 有 95 个 caller 结果；不能只改 `main.ts`，必须核对 commit agent、task subagent/revive、tan/ACP 和 SDK embedding 的语义。
  - `AgentRegistry.global()` 的直接读取跨越 collab、internal URLs、IRC、interactive controllers、task executor、isolation、persisted revive。阶段 2 不能只改 `agent-registry.ts`；所有依赖「进程里只有一个 Main」的生产读取都必须改为 slot context。
  - `eval/js/process-entry.ts` 与 `worker-core.ts` 的 cwd 是独立 eval worker 的 cwd，不归 session host，不改。
  - 开工时对上述 qualified symbol 再跑 `cg callers`，并用 grep 逐行确认；新增或漏掉的生产调用点必须先更新 §1 白名单。
- 思路：host 按 project dir 活在现有 broker 进程里。客户端进程只留 TUI 和连接。`attach` 新建 slot 或挂上已有 slot。`resume` 从 journal 装回。slot 记住自己的 cwd，工具和 shell 用这个 cwd，host 进程的 cwd 不动。最后一个 `detach` 把 slot 从内存卸掉，journal 还在，下次 `resume` 再装。SIGINT 只取消该客户端正在跑的 turn，不杀 host。

不选的做法：

- 每个会话一个 omp 子进程，父进程只转发电线。省不下运行时，因为堆在子进程里。这就是今天的模型，只是多了一跳。
- 把 TUI 也放进 host，客户端只传字节。host 就要知道每个客户端的终端尺寸和 stdout，`InteractiveMode` 今天直接占 `process.stdout`，这一步比 session slot 大，不做。

## 3 实现什么功能

对外行为：

- 同一 project dir，第一个 `omp` 拉起 host。第二个 `omp` 连接同一个 socket，不再加载第二份 `AgentSession` 模块图。
- `omp --resume <id>` 在 host 里装回该 journal，第二个客户端看到同一段历史，而不是各读一份拷贝后分叉。
- 两个客户端可以附着不同 session id，互不串 prompt、互不串 cwd。
- 客户端退出：只 `detach`。另一个客户端的 turn 继续。最后一个客户端离开后，slot 卸出内存；journal 还在。
- host 崩溃后重新拉起：`resume` 从 journal 恢复到上次落盘的条目。崩溃当时没写完的 turn 丢失，客户端得到明确错误，不假装还在继续。
- Ctrl-C：取消当前客户端这一 turn。host 和其他会话还在。

边界：

- 空 journal：`resume` 失败，错误说明找不到会话，不创建空会话冒充。
- 同一 session 两个客户端同时 `prompt`：第二个得到「busy」，不并行跑两个 turn。
- cwd 被删：该 slot 的 shell工具失败，host 不跟着 chdir 失败而退出。
- 不同 project dir：不同 socket，不同 host。不把所有项目塞进一个进程。

不做：

- 不把阶段 1 没上收的资源再做一遍。
- 不支持一个客户端同时画两个会话。
- 不做跨机器 host。
- 不改 journal 格式。

## 4 补充什么测试

位置：`packages/coding-agent/test/launch/session-host.test.ts`。用真 socket 和真 journal 临时目录，不 mock `AgentSession` 的方法名。

- `second client resumes the same journal`：哪种 bug 会红——第二个进程自己 `createAgentSession`，写出第二份历史。
- `two session ids do not share cwd`：哪种 bug 会红——slot 用了 `process.chdir`，后一个会话把前一个的 cwd 改掉。
- `sigint cancels one turn only`：哪种 bug 会红——SIGINT 走到 `postmortem` 把 host 退出。
- `last detach unloads the slot and resume reloads it`：哪种 bug 会红——卸载后对象还在，或 resume 读不到 journal。
- `concurrent prompts on one session return busy`：哪种 bug 会红——两个 turn 同时写同一 journal。

不写：不测 wire JSON 字段顺序，不测 `SessionSlot` 的私有字段，不把阶段 1 的 MCP 测试再抄一遍。

## 5 验收条件(必须标 commit)

- [ ] `bun test packages/coding-agent/test/launch/session-host.test.ts` 通过 — `<SHA>`
- [ ] `git diff --name-only <基线>..HEAD` 全在 §1 — `<SHA>`
- [ ] §6 的两个客户端 RSS：第二个进程比自己单独冷启动的空 omp 至少少阶段 0 测得的「运行时与模块图」的一半 — `<SHA>`
- [ ] `cg changes <基线>` 非 critical — 回执写 risk
- [ ] `git grep -n process.chdir packages/coding-agent/src/launch packages/coding-agent/src/modes packages/coding-agent/src/main.ts` 没有 host 路径上的新调用 — `<SHA>`

省内存这条规定以阶段 0 的桶为准。阶段 0 没给数字，本条不能打勾。

## 6 模拟测试功能(smoke)

cwd：worktree 根，使用一个只有少量文件的临时项目，避免把本仓库的会话卷进去。

1. 终端 A：`omp`，问一句，记下 host pid（broker pid）和 A 的 RSS。
2. 终端 B：同一目录再开 `omp`，`ps -o pid,rss,args` 确认没有第二个完整 omp 运行时；B 的 RSS 记下来。`--resume` A 的会话 id，能看到 A 的那一句。
3. B 开另一个新会话，`cd` 到临时子目录跑 `pwd`。A 再跑 `pwd`，仍是原目录。
4. Ctrl-C 只停 B 的当前 turn。A 继续提问得到回答。
5. 关掉 A 和 B。`resume` 该 id，历史还在，host 在 idle grace 后退出。

每步写命令、cwd、stdout、pid、RSS。少一步就不算过。

## 7 清理什么

- [ ] 一次性 smoke 脚本已删
- [ ] 没有留下 `OMP_SESSION_HOST=0` 之类的永久双路径。客户端要么连 host，要么这阶段没合并
- [ ] 本次造成的未用 import 已清
- [ ] 不改 README，除非启动方式对用户可见（多一个必填 flag 才算可见）

## 8 禁止项

- 禁止改 §1 以外的文件。`agent-session.ts` 只有 §1 允许的那种单点注入
- 禁止新依赖，禁止第二套会话存储
- 禁止 `git add .`，禁止根工作树
- 禁止把所有 project dir 合成一个 host
- 禁止在 host 里 `process.chdir`
- 禁止让 SIGINT / SIGTERM 直接退出 host
- 禁止顺手拆 `agent-session.ts`

## 9 并发边界

单子代理。`launch/broker.ts` 和 `launch/client.ts` 与阶段 1 冲突，必须等阶段 1 合并或放弃后再开分支。

不允许把 subagent registry 隔离延期：当前调查已经证明 `task/executor.ts`、internal URL、IRC、collab 与多个 controller 直接读取 global registry。若无法在本阶段完成 slot-scoped registry/lifecycle，则阶段 2 不具备合并条件，必须停下来拆成新的前置阶段，而不是交付会串会话的 host。

## 10 交接

未开工。开工条件：

1. 阶段 0 回执判定是「进入阶段 2」，并写了运行时桶的 MB。
2. 阶段 1 已合并，或回执写明放弃及原因。
3. 本文件开头的基线 SHA 已改成实际值。
