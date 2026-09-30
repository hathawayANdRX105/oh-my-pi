# 0001. Session host 与精简 viewer 客户端（阶段 2 替代方案 A）

**Date**: 2026-09-24
**Status**: Proposed

## Summary

把 N 个 omp 会话搬进一个 host 进程（现有 project broker 内），每个会话是一个 SessionSlot。客户端换成独立的轻量二进制 ompv，只装终端渲染库和会话协议客户端，不再加载完整应用。目标是总内存 = daemon 的内存 + N 个会话的内存，实测方向是客户端约 54 MiB 起、daemon 一份约 280 MiB 加每会话状态。旧的完整 omp 入口保持原样，SDK 与脚本不受影响。

## Requirements

**User stories**:
- 作为重度多会话用户，我要在同一个项目里开多个会话而只付一份应用运行时，这样内存随会话数线性慢涨而不是每会话 260 MiB。
- 作为日常用户，我要在 viewer 里完成日常交互（提问、审批、中断、slash、todo 与 goal 面板、diff 预览），体验与现在一致。
- 作为 SDK 与脚本使用者，我要旧的 omp 入口行为完全不变，这样现有自动化不受影响。

**Acceptance criteria**:
- **AC-1**: 同一 project dir 第二个客户端 attach 已运行的 host，不实例化第二份会话运行时（无第二个 AgentSession 构建路径）
- **AC-2**: `ompv --resume <id>` 从既有 journal 装回历史，两个客户端看到同一段历史而不分叉
- **AC-3**: 两个 slot 互不串 prompt、cwd、registry、settings、eventBus（slot 隔离）
- **AC-4**: Ctrl C 只取消当前客户端正在跑的 turn，host 与其他会话继续
- **AC-5**: 最后一个客户端 detach 后 slot 从内存卸载，journal 留盘，resume 可再装回
- **AC-6**: 同一 slot 并发 prompt，第二个得到 busy，不并行跑两个 turn
- **AC-7**: host 无 slot 且无客户端后空闲 10 分钟自动退出，下次冷启动一切可用
- **AC-8**: host 崩溃后 resume 恢复到 journal 上次落盘条目，未写完的 turn 返回明确错误
- **AC-9**: ompv 进程的 import 闭包不含 AgentSession、tool registry、catalog（以审计脚本断言）
- **AC-10**: viewer 覆盖日常交互全量：prompt、流式文本、工具状态、审批、中断、slash 全集（透传到 host）、todo 与 goal 面板、diff 预览
- **AC-11**: cwd 被删除只让该 slot 的 shell 类工具失败，host 进程不退出
- **AC-12**: PSS 实测回执：viewer 客户端、host 基线、host 每 slot 增量（registry、eventBus、连接开销）分开记录（RSS 与 PSS 各一行），总内存方向符合目标公式

## Decision

**Chosen option**: 方案 A，双入口。现有 `omp` 完整入口原样保留（in-process，SDK、ACP、脚本兼容），新增独立轻量二进制 `ompv`（只装 pi-tui 和会话协议客户端）；会话全部跑在既有 project broker 进程内的 SessionSlot 里，协议集 attach、resume、prompt、command、event（带 seq + 环形重放）、approve、cancel、detach，错误为 busy / not_owner / needs_full_reattach；多客户端严格 owner 语义；journal 复用 FileSessionStorage；broker 在无 slot 无客户端后空闲 10 分钟退出。方案 B（字节流终端，客户端只传终端字节）推迟，做之前单独决策。

**Implementation skills**: 无（项目 `.agent/skills/` 未安装与本决策相关的社区技能）

## Feature design

**Data model sketch**:
- SessionSlot（host 内存对象，非持久实体）: sessionId（string，journal id）、cwd（string）、agentSession（AgentSession 实例）、registry（slot 私有 AgentRegistry）、settings（slot 注入）、sessionManager、eventBus、clients（连接集合，含各自 clientId）、turnOwner（string，当前 turn 发起者）、eventRing（seq + 有界缓冲，`OMP_SESSION_EVENT_RING`）、cancelController、lastActivity
- 持久层不变：FileSessionStorage 的 JSONL journal（既有格式，不新增存储）

**State transitions**:
- slot: attached（新建或 resume 装回）→ active（有客户端且有 turn）→ idle（无 turn）→ owner-absent（turn 在跑但 turnOwner 断连，观察者只读）→ detached（最后一个客户端离开且无在跑 turn，卸载出内存，journal 留盘）
- owner-absent 规则：owner 断连不取消在跑 turn；turn 结束后若无任何客户端，slot 走 detached 卸载。卡住上限：owner-absent 的在跑 turn 仍受 slot 既有停止条件约束（retry 次数、超时、auto-pause）；若无任何客户端可接且 turn 到达硬上限仍未 settle，host 将 slot 视为 idle 并进入卸载计时，不无限挂起
- broker: running（有 slot 或有客户端）→ idle（全空，计时 10 分钟）→ exited（退出码 44 语义对齐 jcode，下次冷启动）

**Protocol surface**（走既有 broker 的已认证 socket，不新开端口）:
| 消息 | 方向 | 关键输入 | 关键输出 | 关键错误 |
|---|---|---|---|---|
| attach | 客户端到 host | sessionId 可空、resume 标记、cwd、since 事件游标 | slot id、当前事件游标、历史快照、owner 身份 | journal 不存在 |
| resume | 客户端到 host | sessionId、since | 自 since 起的事件流 | journal 为空报明确错误 |
| prompt | 客户端到 host | 文本、附件引用、ownerId | turn 事件流 | busy（AC-6）、not_owner |
| command | 客户端到 host | slash 命令串、ownerId（透传） | 命令结果与 UI 帧 | 未知命令 |
| event | host 到客户端 | 会话事件（复用 rpc 事件词汇） | 流式文本、工具状态、审批请求、todo/goal/diff 状态、UI 帧，每条带 seq | 无 |
| approve | 客户端到 host | 审批 id、批准/拒绝、ownerId | 确认 | not_owner |
| cancel | 客户端到 host | ownerId | 取消确认 | not_owner |
| detach | 客户端到 host | 无 | 确认 | 无 |

**Wire 与重放**：
- 每条 `event` 携带单调 `seq`；slot 维护有界环形缓冲（默认最近 4096 条，可配）。
- `attach`/`resume` 带 `since`（最后收到的 seq）。判定顺序：(a) `since` 在环形缓冲内 → 直接补发该区间；(b) `since` 早于缓冲最旧 seq，但 journal 里有对应持久化条目 → 从 journal 重建到 `since` 再续；(c) `since` 既不在缓冲、journal 也重建不到（seq 是本进程内存计数器，崩溃后重置，无法映射到旧 seq）→ 返回 `needs_full_reattach`，客户端从 journal 全量 `resume` 重来。`seq` 本身不进 journal，崩溃前后不可跨进程续发。

**多客户端（严格 owner，已定）**：
- `prompt`/`cancel`/`approve` 带 `ownerId`（连接建立时的 clientId）。slot 记录当前 turn 的 `turnOwner`。
- 只有 `turnOwner` 的 cancel/approve 生效；非 owner 的操作返回 `not_owner`（AC-4 边界）。
- 非 owner 客户端可 attach 为只读观察者，收全部 event，但发起命令被拒。
- owner 断连：turn 继续跑（不取消）；owner 缺席期间其它客户端只能观察；turn 结束且 slot 无任何客户端时才卸载（AC-5 不变）。

**重连与 todo/goal 状态恢复（2026-09-25 设计，挂 AC-10）**：

现状盘点（逐点核实过）：
- todo：权威状态在 `TodoTracker`（session 级）。`AgentSession` 构造即 `syncFromBranch()` 从 journal 分支重建（`agent-session.ts` 构造路径，`getLatestTodoPhasesFromEntries`），resume 天然恢复。运行中变更以 todo 工具事件 + `todo_reminder`/`todo_auto_clear` 会话事件出现，**没有**独立 `todo_updated`。读取口：`session.getTodoPhases()`。
- goal：权威状态在 `AgentSession.#goalModeState`，经 `appendModeChange("goal"|"goal_paused", { goal })` 落 journal；运行期发 `goal_updated` 会话事件。**恢复逻辑目前只在 TUI**：`interactive-mode.ts #reconcileModeFromSession()` 从 `buildSessionContext()` 读 mode/modeData 重建 goal、`goalRuntime.onThreadResumed()` 处理状态迁移、重挂 goal 工具。host 路径（仅 `createAgentSession`）不重建 goal → 断线重连后 goal 面板与 goal 工具双丢，这是本设计要修的洞。
- host 现有重连面：attach(resume) 重开 journal + 按 `since` 补放事件环（越界 `needs_full_reattach`）；重连客户端拿新 clientId，在跑 turn 期间只能是观察者。

机制（快照 + 重放，不加新存储，journal 仍是唯一持久层）：

1. **attach/resume 响应带 `state` 快照**（`SessionStateSnapshot { todoPhases, goal }`）。来源：`session.getTodoPhases()` + `session.getGoalModeState()`；`SessionRuntime` 加可选 `snapshotState()`，host 经 `runInSessionRuntime` 调用（与 `#publish` 同一道包装）。viewer 用快照直接渲染 todo/goal 面板，随后靠事件流增量维护：goal 用 `goal_updated`，todo 沿用 todo 工具事件 + reminder 事件（与 interactive TUI 同一推导逻辑）。不发明 `todo_updated` 合成事件。
2. **host 侧 goal 装配**：把 `#reconcileModeFromSession` 的 goal 分支提为 session 级 helper（journal modeData → `setGoalModeState` → `onThreadResumed({ preserveActiveGoal: false })` → 重挂 goal 工具），`createDefaultSessionRuntime` 在 `createAgentSession` 后调用；interactive-mode 保留 vibe/plan 交织部分、只共享该分支。语义与今天一致：resume 时 active goal 自动转 paused，由下一条用户 prompt 自动恢复（既有行为）。
3. **owner 接管**：attach 时若 `turnOwner` 在跑但其 transport 已断（owner-absent），新 attach 直接承接 owner 身份（本地单用户信任域，不加协议字段）；否则维持观察者。上一条「owner 缺席期间其它客户端只能观察」据此收窄为「非本人重连」。
4. **边界**：
   - slot 已卸载（最后客户端离开且无 turn）：attach(resume) 重建运行时，todo 走构造期 rehydrate、goal 走 (2)，快照正确。
   - host 崩溃：seq 重置 → `needs_full_reattach` → 客户端全量 resume；快照兜底面板，未完成 turn 明确报错（AC-8 不变）。
   - goal 续跑（host 侧自动 continuation）在客户端缺席期间照常进行：事件进环，重连后快照 + 重放对账；turn 存续期间 host 不空闲退出。

验证场景：
- journal 含 goal `mode_change` 时 attach(resume)：`state.goal` 非空且 goal 工具可调用（(2) 的回归测试，今天会失败）。
- goal turn 中途重连：快照 goal 状态 = 活状态；缺席期 `goal_updated` 按 seq 补齐。
- 建 todo → detach → resume：`state.todoPhases` 与 journal 一致。
- owner 断连后重连：新 attach 获得 owner；第二个客户端仍为观察者。

**Value sourcing**（每个 AC 需要的值与来源）:
| 动作 | 产生的值 | 来源 |
|---|---|---|
| attach | slot 的历史视图 | FileSessionStorage journal（既有） |
| attach | 重放起点 seq | slot 环形缓冲 / journal 可重建边界 |
| event 流 | 流式文本、工具状态、审批请求、UI 帧 | host 内 AgentSession 事件，序列化沿用 rpc 事件词汇（`modes/rpc/` 既有实现） |
| event 流 | 每条的 seq | slot 侧单调计数器（attach 时对齐到 journal 尾序） |
| prompt 的 cwd | slot cwd | attach 时的客户端 cwd（规范目录），slot 私有 |
| prompt | turnOwner | 发起 prompt 的 ownerId（连接身份） |
| command 结果 / UI 帧 | 全量 slash 输出与可序列化 UI | host 侧执行（见下「viewer 边界」），viewer 只渲染 |
| busy 判定 | slot 是否有活跃 turn | slot.cancelController 状态 |
| 审批回传 | 批准或拒绝 | viewer 交互，ownerId 回传 host |
| idle 退出 | 10 分钟计时 | 可配环境变量，默认 600000 毫秒 |
| PSS 回执 | viewer/host 基线/每 slot 增量 | 各进程 PSS 计数器（Linux `/proc/<pid>/smaps_rollup`，各一行 RSS+PSS），N 会话与 N-1 会话差值即每 slot 增量 |

**Key invariants**:
- host 进程内禁止 `process.chdir`（slot cwd 只注入会话与工具，见 `packages/utils/src/dirs.ts` 的 `setProjectDir` 只允许旧入口路径）
- 每个 root slot 私有 registry 与 lifecycle，禁止回退到 `AgentRegistry.global()`（旧任务书 §1 的全局读取点清单全部改造）
- owner 门控：`prompt`/`cancel`/`approve` 仅 `turnOwner` 可发起；非 owner 一律 `not_owner`（AC-4）
- SIGINT 只路由到当前客户端的 turn，不触达 host 进程退出路径
- journal 单写者：同一 slot 同一时间只有一个 turn

**viewer 边界（全量 slash，已定）**：
- ompv 只装 pi-tui（终端渲染）与会话协议客户端；不 import `AgentSession`、tool registry、catalog（AC-9）。
- slash 全集「透传到 host」：viewer 把 `/cmd` 通过 `command` 消息发给 host，host 用完整应用执行，viewer 只渲染 host 回传的 UI 帧。viewer 侧只持有命令的**声明式补全元数据**（名字/参数/提示），不含执行逻辑。
- UI 帧是可序列化载荷（文本 / 结构化选项 / 状态 / diff）；任意自定义 TUI 组件工厂（extension `custom()`）在 host 侧降级为「结构化文本 / JSON」输出，viewer 原样渲染——这是为保住全量 slash 与 import 闭包付出的渲染保真度代价。

**Security model**:
- 认证沿用 broker 既有 token（同一 socket，同一信任域，本机单用户场景）
- slot 之间无跨会话读取；registry、history、memory、artifact 全部按 slot 隔离
- owner 身份 = 认证连接建立时分配的 clientId；同 socket 内按 clientId 区分，不做跨 socket 提权

**Configuration required**:
- `OMP_HOST_IDLE_EXIT_MS`: host 空闲退出毫秒数，默认 600000（10 分钟）。与阶段 1 的 `OMP_DAEMON_IDLE_GRACE_MS`（默认 3000）并存：有 slot 或 session 客户端时以 host 空闲计时为准，纯 daemon（无 slot）时沿用旧 3000 语义
- `OMP_SESSION_EVENT_RING`: 每 slot 事件环形缓冲条数，默认 4096

**Critical test scenarios**（对应 AC）:
- Happy path: 第二个客户端 attach 后共享同一会话历史，verifies **AC-1**、**AC-2**
- Failure case: 同 slot 并发 prompt 得 busy，verifies **AC-6**；host 崩溃后 resume 到落盘条目，verifies **AC-8**
- Isolation: 两个 slot 各自 cd 与 prompt 不串，verifies **AC-3**；SIGINT 只停本端 turn，verifies **AC-4**
- Owner 门控: 非 owner 客户端 cancel/approve 被拒为 `not_owner`，owner 断连后在跑 turn 继续、turn 结束且无客户端才卸载，verifies **AC-4**、**AC-5**
- 重放: 客户端带旧 `since` reattach，先补发环形缓冲内事件，越过缓冲边界则回 `needs_full_reattach`，verifies **AC-2**

## Build plan

Tracer Bullet：先打通一条端到端竖切（host 承载一个 slot，ompv 连上并完成一次 prompt），再逐层加厚。

1. `session-protocol.ts` 消息定义（attach/resume/prompt/command/event/approve/cancel/detach + busy/not_owner/needs_full_reattach）与 broker 内 session host 多路复用骨架（slot Map、attach、detach、clientId 分配），satisfies **AC-1**
2. SessionSlot 装配：slot 私有 registry、settings、cwd、sessionManager 注入 `createAgentSession`，journal resume 装回；隔离清单开工时合并旧任务书 §1 全局读取点与 `cg callers AgentRegistry.global()` 重跑结果（并补 `LocalProtocolHandler.setOverride`、`setActiveSkills`/`setActiveRules`、`AsyncJobManager`、`getProjectDir` 直接读点），逐文件回执，satisfies **AC-2**、**AC-3**
3. prompt、event（带 seq + 环形缓冲重放）、cancel、busy、owner 门控与 SIGINT 路由（AC-2 的重放/重连路径在此实现，AC-2 主属 task 2 的 journal 装回），satisfies **AC-4**、**AC-6**
4. detach 卸载、owner-absent 语义、idle 10 分钟退出（host 空闲 vs 纯 daemon 3000 并存）、崩溃恢复，satisfies **AC-5**、**AC-7**、**AC-8**
5. `ompv` 独立轻量入口（构建管线加目标）与 import 闭包审计（构建期脚本断言 ompv 产物模块图不含 AgentSession、tool registry、catalog 模块，进 CI），satisfies **AC-9**
6. viewer 全量交互：流式、工具状态、审批、todo/goal 面板、diff 预览，slash 全集经 `command` 透传 host 执行、viewer 渲染 host 回传 UI 帧（自定义 TUI 组件降级为结构化文本/JSON），satisfies **AC-10**
7. 测试套件 `test/launch/session-host.test.ts`（第二个客户端 resume、slot cwd 隔离、SIGINT、owner 门控/not_owner、最后 detach 卸载、并发 busy、重放游标 needs_full_reattach、double-detach 幂等、owner-absent 卡住上限、host(600000) vs 纯 daemon(3000) idle 优先级、host 路径无 `process.chdir` 断言）与 PSS 实测回执，satisfies **AC-4**、**AC-5**、**AC-11**、**AC-12**

## Consequences

**Positive**:
- 总内存达成目标公式：每加一个会话约加 54 MiB 客户端加 host 内会话状态，而不是 260 MiB
- 会话获得持久化与多端附加能力（host 崩溃可恢复、两窗口同会话）
- 阶段 1 的重资源共享自然续接（host 就是 broker，MCP、embedder、browser 全体客户端共享）

**Negative / tradeoffs**:
- 协议层是新的故障面：客户端与 host 之间的断连、重连、事件丢失都要处理
- slot 隔离改造要触碰大量直接读全局 registry 的生产路径（旧任务书 §1 清单），是本方案最大的工程量
- 双入口长期维护：ompv 的功能要与 omp 交互层持续对齐
- viewer 首版可能缺低频管理界面（MCP 管理、settings 编辑器），需要用旧入口补
- 全量 slash 换取 import 闭包保真：自定义 TUI 组件（extension `custom()`）在 viewer 里降级为结构化文本/JSON，像素级还原不保证；换的是「全命令可用 + 客户端不加载重模块」
- 每 slot 事件环形缓冲（默认 4096 条）占 host 内存：N 会话 × 4096 条，长事件会话需按 `OMP_SESSION_EVENT_RING` 调低

**Neutral**:
- 构建管线多一个二进制目标（`ompv`）
- 旧阶段 2 任务书由本 spec 取代（另加 superseded 标记）
- 方案 B（字节流终端）作为后续单独决策保留

## Migration plan

**Strategy**: strangler（omp 旧入口与 ompv 并存，旧入口不撤，按会话逐步迁移）
**Phases**:
1. 竖切：host 承载单 slot，ompv 打通 attach、prompt、流式、detach（AC-1、AC-2、AC-4）
2. 加厚：slot 隔离（registry、settings、cwd）与并发 busy、崩溃恢复（AC-3、AC-6、AC-8）
3. 全量交互：ompv 日常交互全量与审计断言（AC-9、AC-10）
4. 收尾：idle 退出与 PSS 回执（AC-7、AC-11、AC-12）
**Rollback**: ompv 是独立二进制，直接停用即可回到旧入口；host 侧改动集中在 launch 与新文件，revert 单一提交即可恢复；journal 格式不变，无数据迁移
**Risks**: slot 隔离改造触碰大量全局 registry 读取点，漏一处就串会话（以旧任务书 §1 清单逐文件回执兜底）；协议层断连重连是新故障面

## Follow-up

- [ ] slot 私有 registry 改造完成时，逐文件回执旧任务书 §1 清单的全局读取点（collab、internal urls、IRC、controllers、task executor）
- [ ] 方案 B 开工前单独 spec 决策（是否放开 packages/tui 渲染禁区）
- [ ] 仓库无根 `.agent/rules/local-agents.md`，建议先跑 `/wf-audit` 补真实上下文
- [ ] `ompv` 命名与安装方式（`~/.local/bin/ompv` 或 `omp viewer` 壳命令）在实现时定稿

## Rationale

推理与备选权衡：见 [rationale.md](rationale.md)。
