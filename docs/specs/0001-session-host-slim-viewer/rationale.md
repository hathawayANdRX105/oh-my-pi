# 0001 Rationale: session host 与精简 viewer 客户端

## Context

用户目标（原话口径）：总内存 = daemon 的内存 + N 个会话的内存。之前的世界是每个会话一个完整 omp 进程（omp 加会话），N 个会话付 N 份应用成本。用户要求把可复用的部分做成单份，让会话复用，省掉 N 1 份。

实测数据（2026-09-24，本机探针，PSS 为真实物理占用，RSS 含共享文件映射页会虚高）：
- 裸 bun 运行时：PSS 17.2 MiB。bun 本身很轻，重的不是运行时。
- 完整 omp 会话（idle）：PSS 240.7 到 281.1 MiB（RSS 278 到 320）。每会话约 260 MiB 的大头是 omp 应用模块图，不是 bun。
- 精简 viewer 探针（只 import pi-tui 加 net）：PSS 54.3 MiB。
- 阶段 1 已合并（PR #4，`ebe725227f`）：project broker 已持有 MCP transport、Mnemopi embed worker、browser 生命周期，多客户端 socket 加 token 认证已实测可用。

旧阶段 2 任务书（`todo/handoff/session-daemon-2-session-host.md`）自带的内存硬门槛（阶段 0 判定、80 MiB 桶）已被用户判定为误导并删除，基线更新为 `0ac1b4222e`。本 spec 取代该任务书。

## Options considered

### Option 1: 精简 viewer 客户端（选定）
新独立轻量二进制 ompv，只装 pi-tui 和会话协议客户端；TUI 仍在客户端渲染；会话运行时全部在 host。
**Pros**:
- 达成内存公式：客户端 54 MiB 起步，N 个会话是 N 乘以薄客户端加一份 daemon
- 不碰 packages/tui 渲染原语（当前禁区）
- rpc 事件词汇现成可复用（scout 确认 `modes/rpc/` 的序列化实现）
**Cons**:
- 交互层（slash、controllers、审批）要按协议重接，全功能 viewer 工作量中等偏大
- 双入口长期维护，viewer 功能要与 omp 持续对齐

### Option 2: 字节流终端（方案 B，推迟）
TUI 全在 host 渲染，客户端只传终端字节，客户端 PSS 目标 20 MiB 量级。
**Pros**:
- 客户端最薄，总内存最低（N=3 约 520 MiB）
**Cons**:
- 要重定向 packages/tui 渲染（禁区）、剥离 InteractiveMode 的 stdout 占用、host 管理 N 路终端状态（尺寸、光标、SIGINT 路由），风险最高
- 实质触碰会话循环与渲染层

### Option 3: 按旧任务书原样（客户端保留完整应用，仅 AgentSession 进 host）
**Pros**:
- 改动面最小（只动会话装配），买会话持久化与多端附加
**Cons**:
- 内存目标达不成：客户端每进程仍 260 MiB，总内存约 1240 MiB（N=3），比今天 780 MiB 反升，因为多付了一份 daemon 运行时

### Option 4: 不做 host（fix in place，维持现状）
**Pros**:
- 零风险零成本
**Cons**:
- 用户目标（内存随会话数慢涨）无法达成；每会话 260 MiB 固化

## Rationale

选 Option 1。决定性的三个力：
1. 实测算术：viewer 探针 54.3 MiB 让"总内存 = daemon + N 会话"成立（N=3 约 620 MiB，对今天 780 MiB），Option 3 的算术是反升的（约 1240 MiB），直接出局。
2. 禁区约束：packages/tui 渲染原语与 AgentSession 对话循环是既有约束的禁区，Option 1 客户端渲染不动渲染原语，Option 2 实质触碰，因此 Option 2 推迟为方案 B，开工前单独决策。
3. 复用：阶段 1 的 broker（socket、token、多客户端）是现成的承载层，rpc 事件词汇现成，Option 1 的增量集中在 slot 隔离与 viewer 交互层，这两块本来就无法回避。

运行时单份的准确表述（用户说"bun 运行时做单个"）：裸 bun 只有 17 MiB，真正被单份化的是 omp 应用模块图（约 220 MiB）。host 承载它，ompv 不再加载它。

## References

**Project sources**（仓内可验证）:
- `docs/scope/scope.md`（本决策的 scope，方案 A 与方案 B 两行）
- `todo/handoff/session-daemon-1-heavy-workers.md`（阶段 1 交付，PR #4 `ebe725227f`）
- `todo/handoff/session-daemon-2-session-host.md`（旧阶段 2 任务书，被本 spec 取代，其 §1 全局读取点清单仍作为改造清单使用）
- `packages/coding-agent/src/launch/broker.ts`、`launch/client.ts`（阶段 1 broker 承载层）
- `packages/coding-agent/src/modes/rpc/`（rpc 事件词汇，viewer 复用）
- 会话探针实测记录（2026-09-24：viewer 探针 PSS 54.3 MiB、裸 bun 17.2 MiB、omp idle PSS 240.7 与 281.1 MiB）

**Practices & standards**:
- strangler pattern（旧 omp 入口与 ompv 并存，按会话逐步迁移，旧入口不撤）
- measure before you optimise（本决策全部建立在 PSS 探针实测上）
- boring technology（复用既有 broker socket、token、journal，不新增依赖与存储）
- one runtime many sessions（jcode 的 server.rs 会话承载行为参照，只抄行为不抄代码）
