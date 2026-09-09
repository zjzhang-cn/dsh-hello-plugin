# dsh AGENT 插件（`@deepseek-ai/dsh-agent`）

> 一句话：hello-plugin 一直在用的 `ctx.agents`，**本身就是另一个 Cordis 插件提供的服务**。AGENT 插件 = 注册表 + Agent 句柄 + 进程内归属（initiator scope）+ `agent/*` 事件词汇表 —— **自己不跑模型**，创建/驱动委托给 `dsh-agent-loop`。
>
> 与其它文档的分工：[plugin-capability-catalog.md](plugin-capability-catalog.md) 是全目录；[hello-plugin-capabilities.md](hello-plugin-capabilities.md) 是本插件使用全景；[agent-capabilities.md](agent-capabilities.md) 是「用 Agent 能做什么」的能力深潜；**本文是「ctx.agents 这个插件本身」的包画像** —— 架构、依赖、API、事件、生命周期，以 harness 源码与官方 README 为据。

## 1. 包定位

`dsh-agent`（harness `packages/core/agent/`）自述提供四样东西：

| 组成 | 内容 | hello-plugin 触达 |
| --- | --- | --- |
| **Agent handle** | 插件编程面对的控制面：followup / steer / inject / cancel / whenIdle | ✅ followup、whenIdle |
| **Live registry**（`ctx.agents`） | 追踪所有存活 agent：create / resume / get / list / roots / isOwnedBy | ✅ create |
| **Initiator scope** | AsyncLocalStorage 链，把异步工作归属到发起它的 agent（进程内因果归因；无界不证明存活，显式身份在 worker/进程/持久化/线边界仍权威） | 隐含（后台会话） |
| **`agent/*` 事件词汇表** | agent/created、agent/disposed、agent/status、agent/pre-step、agent/request-error、agent/turn-stopping、agent/inbox/* | 宿主建会话触发 created / disposed |

运行时实现随包发布（`lib/index.js`），但 harness 的 dev profile 跑工作区源码；hello-plugin 对它 **type-only**（peer + dev、`import type`），产物无运行时裸依赖。

## 2. 核心架构：registry 与 driver 分层

```
┌─ dsh-agent（本插件，无循环依赖）───────────────┐
│  ctx.agents：AgentRegistry（存活的 agent 表）    │
│   ├─ create()/resume() ──委托──▶ 注册的 factory  │
│   ├─ Agent handle（唯一可拆解该 agent 的对象）    │
│   └─ initiator scope + agent/* 事件              │
└──────────────┬─────────────────────────────────┘
               │ 工厂注册（registerFactory）
┌──────────────▼─────────────────────────────────┐
│ dsh-agent-loop（驱动插件）                       │
│  实际创建/续启会话、驱动模型循环、step 准入判定     │
│  每轮经 agent/pre-step 等事件缝对外可见           │
└─────────────────────────────────────────────────┘
```

- **消费方只依赖 `dsh-agent`、从不依赖 loop** —— 驱动可整体替换（README：「service is inert until a driver registers a factory」；最小可用组合 = 两者一起挂载）。
- 发布顺序保证：工厂先建 session（发 `session/created`）→ 构造 agent → `enter()` 到 `announce()` 之间跑 `setup(agentCtx)` 组装作用域世界（可回滚）→ announce（发 `agent/created`）→ 之后才可见。**观察者永远看不到半配置的 agent**。

## 3. 依赖底座（peerDependencies 暴露的能力边界）

`dsh-agent` 不是孤立包，而是 core 组一员（同组：agent-loop、session、tools、scope、system-prompt、agent-default-model、agent-tool-presentation）：

```
cordis（框架）
dsh-session / dsh-session-projection  ← 会话日志本体（seq、events、投影）
dsh-llm                               ← 模型路由（agentOptions.provider/model）
dsh-tools                             ← 工具注册表（作用域注册经它）
dsh-scope                             ← agentCtx scoped context 机制
dsh-system-prompt                     ← 提示词 section 组装
dsh-typert-protocol / dsh-invariants  ← 事件/远程词汇与不变量
```

这解释了本项目代码里的两个现象：`ctx.tools.register` 从 agentCtx 调用只对该 agent 生效（ScopedLayers）；`setup(agentCtx)` 里能装私有工具 —— 因为 **`Agent.ctx` 本身就是一个 scoped context**：经它注册的 tools、prompt sections、事件监听、限制都只作用于该 agent，dispose 时一并解开。Agent presets 给单个会话换能力集用的也是同一机制。

## 4. `ctx.agents` 服务 API

| API | 语义 | 备注 |
| --- | --- | --- |
| `create(options)` | 全新 agent + 会话（同一身份），委托工厂 | ✅ hello-plugin 用（`CreateAgentOptions` 见 agent-capabilities.md 第 2 节） |
| `resume(options)` | 载入持久化会话重建 agent | 续聊入口；持久化面在 sessionPersistence（hello-plugin 未挂） |
| `get(id)` / `list()` / `roots()` | 找存活 agent | `get` 返回裸 `Agent`，**不返回 handle** |
| `isOwnedBy(id, owner)` | 一个 agent 是否经另一 agent 的作用域创建 | 子代理血缘 |
| `register(agent)` | 记录已构造的 agent | 工厂内部用 |
| `enter` / `announce` | 注册的两段式：setup 与发布间可回滚 | 工厂内部用 |
| `withInitiator` / `withoutInitiator` | 驱动全程包在 initiator 里；共享计时器等无关进程内工作用 without 隐藏 | 内部/驱动用 |
| `setFactory(factory)` | 驱动注册工厂的缝 | 返回解除函数 |

**Ownership 不变量**：`AgentHandle` 的 disposer 是能力 —— 只有持有者能拆掉 agent；工厂提供方是结构共同 owner（作用域 agent 依赖其服务 API，provider 卸载会 stop + drain 它创建的每个 handle）。

## 5. Agent 控制面（handle / 裸 Agent）

| API | 语义 | hello-plugin |
| --- | --- | --- |
| `handle.dispose()` | **停 loop → 拆 scope → detach agent → detach session**（id 随即复用） | ⬜ —— CLAUDE.md 坑 7「dispose 会删会话」即此 |
| `agent.followup(msg)` | 排普通下一轮，唤醒驱动 | ✅（news / jira 任务驱动） |
| `agent.steer(msg)` | 提交干预输入，唤醒 | ⬜ |
| `agent.inject(msg)` | 加模型上下文**不唤醒**（落进下一个被接受的 step） | ⬜ |
| `agent.send(msg, target, wakeup)` | 定向排队 | ⬜ |
| `agent.cancel(cause)` | 中止活动；清 inbox（除非 keepInbox） | ⬜ |
| `agent.whenIdle()` | 等**整个 agent** 静止 | ✅（jira 分析收口） |
| `agent.session` | 会话本体（事件日志 seq/events） | ✅（boundary + 折叠） |
| `agent.ctx` | scoped context：tools / prompt sections / 监听 / 限制只对本 agent 生效 | ✅（经 setup 参数 = agentCtx） |

四种入站消息的精确差别：`followup` 唤醒的普通下一轮、`steer` 唤醒的干预、`inject` 不唤醒的上下文、`send` 定向 —— 都作为 user-role 消息进 inbox，claim 后进入 step 准入。

## 6. `agent/*` 事件：不改 loop 的插桩缝

| 事件 | 用途 |
| --- | --- |
| `agent/created` / `agent/disposed` | 生命周期（Web UI 会话列表、协调状态） |
| `agent/status` | UI / 状态机（invariant 伴生：非法跳转即失败） |
| `agent/pre-step` | **拒绝或替换**即将进入模型的 message 批次；enter 分支可声明 `startsRequestSeries`（wrap 的监听须保留该声明与批次，除非有意替换） |
| `agent/request-error` | 监听者可重试失败的模型请求 |
| `agent/turn-stopping` | 在正常完成的 turn 闭合前运行，可干预让它保持打开 |
| `agent/inbox/*` | 每消息通知，inbox 投影同步 |

> 对应 hello-plugin 的实践：宿主建会话自动触发 `session/created` + `agent/created` → api 层转 remote → Web UI 自动出现。CLAUDE.md 坑 6 的「听 `agent/error`」即这类事件面。

## 7. 源码地图（harness packages/core/agent/）

| 文件 | 角色 |
| --- | --- |
| `src/index.ts` | 插件入口：`AgentRegistry`、工厂槽、initiator scope、Create/ResumeAgentOptions |
| `src/runtime-types.ts` | `Agent`、`AgentStatus` 与 `agent/*` 事件声明 |
| `src/types.ts` | `AgentOptions`（provider/model/reasoningEffort/maxTokens）、取消原因、inbox 词汇 |
| `src/inbox.ts` | Inbox 投影（在持久化 `agent/inbox/spliced` 事件上） |
| `src/dispatch.ts` | `agentEvents` 融合分发器 + `assembleContextFor(agent)` |
| `src/consumed-work.ts` | `foldConsumedWork(events)` |
| `src/model-selection.ts` | `installModelSelection`（选择与装配/路由耦合） |
| `src/invariant.ts` | 不变量伴生 |

## 8. 与 hello-plugin 的界面（装配位置 + 使用对照）

- **装配**：`dsh-agent` 作为 core 组插件行进入启动图，harness 始终挂载 —— 所以 `ctx.get('agents')` 通常拿得到；hello-plugin 仍做 undefined 容错返回 `agents-unavailable`（`src/host/index.ts`）。
- **使用面（我们只站在 registry 消费面）**：`ctx.agents.create` → `handle.agent.followup` / `whenIdle` + `agent.session` 事件扫描 + `setup(agentCtx)` 作用域注册 —— 全程未触碰 loop、presets、pre-step 插桩、inbox 原语与 resume。
- **运行时序实证**（对照 `src/host/jira-agent.ts`）：create → factory 建 session + setup（本会话无私有工具，全局 `jira_*` 经 tools.view 合并可见）→ announce（UI 可见）→ followup 派任务 → loop 跑轮（逐轮过 pre-step 缝）→ 静止 → whenIdle resolve → 扫 `[boundary, seq末尾)` 事件折叠文本 → 不 dispose 留活口。

## 9. 学习下一步

按依赖关系排序的独立学习面（各配对应包）：

1. `dsh-agent-loop`（默认驱动：create/drive/dispose 实现在这）→ 理解 step 准入与请求序列
2. `agent/pre-step` / `request-error` / `turn-stopping` 插桩 → 不改 loop 干预 agent
3. `Agent.ctx` scoped 注册 → presets 同款机制
4. inbox 原语 + `resume` + `sessionPersistence` → 会话队列化与跨重启续聊
5. initiator scope → 进程内工作归因

练习路径总览见 [learning-path.md](learning-path.md)。
