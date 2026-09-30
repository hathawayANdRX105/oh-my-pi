# Scope: omp session host 重构（阶段 2 替代方案）

omp 是你每天用的 AI 编码终端。本 scope 替换旧阶段 2 任务书：目标是总内存 = daemon 的内存 + N 个会话的内存，omp 应用模块图单份跑在 host 里，客户端变薄，省掉 N 1 份每进程应用成本。实测依据：完整 omp 会话 PSS 240 到 281 MiB，裸 bun 只有 17.2 MiB，pi-tui 加会话协议客户端探针 54.3 MiB。

**Build approach:** Tracer Bullet（每个 feature 端到端打通一条真实可用的竖切）
**Workflow:** Beta（/wf-develop 之后跑 /wf-check verify，再 /wf-test）

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | 阶段 0 内存基线测量 | Foundation | existing |
| 2 | 阶段 1 共享重资源 broker | Foundation | existing |
| 3 | Session host 核心（方案 A 地基） | 方案 A | in-progress |
| 4 | 全功能 viewer 客户端 | 方案 A | in-progress |
| 5 | 字节流终端客户端（方案 B） | 方案 B（以后） | planned |

## Foundations

### 1. 阶段 0 内存基线测量 · existing
三份 handoff 与内存门测量（已由新方案取代其门槛语义，数据仍有效）。code in `todo/handoff/`

### 2. 阶段 1 共享重资源 broker · existing
MCP transport、Mnemopi embed worker、browser 生命周期收进 project broker，多客户端 socket 附加。PR #4（`ebe725227f`）。code in `packages/coding-agent/src/launch/`，`packages/coding-agent/src/mcp/manager.ts`，`packages/coding-agent/src/mnemopi/embed-client.ts`

## 方案 A（先做）

### 3. Session host 核心（方案 A 地基）· in-progress
broker 进程内承载 N 个 SessionSlot（Map sessionId 到 slot）。slot 持有 AgentSession、cwd、取消控制器，隔离 registry、settings、sessionManager、eventBus。协议最小集 attach、resume、prompt、event、cancel、detach。journal 复用 FileSessionStorage，不发明第二套存储。最后一个 detach 卸载 slot，journal 留盘。
**Done when:** 第二个客户端 attach 同一 project broker 不新建会话运行时；两个 slot 互不串 prompt、cwd、registry；SIGINT 只取消本客户端当前 turn；host 崩溃后 resume 从 journal 恢复到上次落盘条目；同 slot 并发 prompt 返回 busy。
- [x] Design it (spec): `/wf-architect session host 核心`
- [ ] Build it: `/wf-develop session host 核心`
   - [ ] 协议与 host 骨架（slot Map、attach、detach）(AC-1)
   - [ ] slot 装配与隔离（registry、settings、cwd、journal resume，隔离清单逐文件回执）(AC-2, AC-3)
   - [ ] prompt、event、cancel、busy 与 SIGINT 路由 (AC-4, AC-6)
   - [ ] 卸载、idle 退出、崩溃恢复 (AC-5, AC-7, AC-8)
- [ ] Verify it: `/wf-check verify session host 核心`
- [ ] Test it: `/wf-test session host 核心`
Spec 0001 · code in（由 /wf-develop 填）

### 4. 全功能 viewer 客户端 · in-progress
独立轻量入口，只装 pi-tui 和会话协议客户端，不加载 AgentSession、工具目录、catalog。交互全量：prompt 提交、流式文本、工具状态、审批请求、Ctrl C 中断、slash 全集（透传到 host 或按协议重接）、todo 与 goal 面板、diff 预览。目标客户端 PSS 100 MiB 量级（探针 54.3 MiB 加协议与面板状态）。
**Done when:** viewer 进程 import 闭包审计无 AgentSession、tool registry、catalog；日常会话含 slash 与审批在 viewer 上完成；PSS 实测回执；旧完整入口保留为 omp 原模式。
- [x] Design it (spec): `/wf-architect 全功能 viewer 客户端`
- [ ] Build it: `/wf-develop 全功能 viewer 客户端`
   - [ ] ompv 独立入口与构建管线目标，import 闭包审计进 CI (AC-9)
   - [ ] 日常交互全量（流式、工具状态、审批、slash、todo/goal、diff）(AC-10)
   - [ ] PSS 实测回执（客户端、host 基线、每 slot 增量分开记录）(AC-11, AC-12)
- [ ] Verify it: `/wf-check verify 全功能 viewer 客户端`
- [ ] Test it: `/wf-test 全功能 viewer 客户端`
Spec 0001 · code in（由 /wf-develop 填）

## 方案 B（以后考虑）

### 5. 字节流终端客户端
TUI 全在 host 渲染，客户端只传终端字节流与信号，客户端 PSS 目标 20 MiB 量级。触碰 packages/tui 渲染重定向与 InteractiveMode 的 stdout 剥离（当前是禁区，做之前需要专门决策）。
**Done when:** 客户端只含终端转发；host 管理每客户端终端尺寸、光标、信号路由；实测客户端 PSS 回执。
- [ ] Design it (spec): `/wf-architect 字节流终端客户端`（开工前先决策禁区是否放开）

## Legend

状态流：planned 到 in-progress 到 done；existing 是流程前已存在的。decision box 是每个 feature 标 `(spec)` 的那一格。方案 A 的两个 feature 用一条 spec 还是两条，由 /wf-architect 判断。
