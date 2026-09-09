# Agent 能力分析（dsh 会话 Agent，以 hello-plugin 为实证）

> 与其它能力文档的分工：[plugin-capability-catalog.md](plugin-capability-catalog.md) 是全目录（服务/通道/插槽逐项清单）；[hello-plugin-capabilities.md](hello-plugin-capabilities.md) 是本插件「已使用 ✅ / 未使用 ⬜」全景；本文聚焦 **Agent 能力面的机制深潜** —— 以本插件跑过的两类 Agent 会话（新闻总结、Jira 分析）与官方 `@deepseek-ai/dsh-agent` 类型面为据，回答「一次 `agents.create()` 之后，Agent 到底能做什么、怎么控制、还差什么」。「`ctx.agents` 这个插件本身」（registry/loop 分层、API、事件、源码地图）见 [agent-plugin.md](agent-plugin.md)。

## 1. 基本模型

「Agent」在 dsh 里指一次 `ctx.agents.create()` 得到的有状态会话执行体：

- `agents.create(options)` → `AgentHandle`；`handle.agent` 是 Agent 控制器，`agent.session` 是会话本体（事件日志 + 元数据）。
- **会话事件日志是唯一事实来源**：Agent 的每一轮交互（user/message、assistant/message、tool/call、tool/result、turn/end）都按 `seq` 追加进 `session`。headless 拿结果、Web UI 回放、失败判定都读它。
- Agent 会话一创建即触发 `api-session/added` Remote 事件 → dsh Web UI 会话列表自动可见，交互过程实时可观测 —— 这是 Agent 区别于「裸 `ctx.llm` 直连」的核心资产。

本项目两个 Agent 会话入口：Jira 分析 `src/host/jira-agent.ts`（`runJiraAnalysisSession`）、新闻会话 `src/host/index.ts` 的 `news/start` 端点。

## 2. 创建面：`CreateAgentOptions` 能配什么

| 字段 | 本项目用法 | 含义 |
| --- | --- | --- |
| `sessionId` | `'jira-' + uuid` / `'news-' + uuid` | 会话唯一身份（brand 类型）。也是 workspace attach、前端事件回传匹配的锚 |
| `meta.cwd` | 新闻 = 宿主进程 cwd；Jira = 插件包根目录（`dirname(dirname(import.meta.url))`） | 会话工作目录，**workspace 归组的判定依据**（attachSession 要求会话 cwd 解析后等于 workspace path） |
| `agentOptions.provider/model` | 取自 `llm.config.json` | Agent 由哪个 LLM 驱动；能力即模型能力，模型可换 |
| `setup(agentCtx)` | 新闻：注册作用域工具 `google_news` | 在会话发布**之前**组装 agent 的私有世界（工厂先 mint agentCtx、await setup、再 announce），观察者永远看不到半配置状态 |
| `signal` | 未用 | 仅创建期的取消信号，句柄可见前分离 |
| `meta.parentSession` / `isSeeded` / `origin: 'subagent'` / `delegationDepth` / `agentPreset` | 未用 | 子 Agent 分叉血缘与递归预算（subagents 体系） |
| `seed` / `inheritedEventCount` | 未用 | fork 父会话的事件前缀（须自 seq 0 连续、无开放 turn、无悬挂 tool call） |

创建例见 `src/host/jira-agent.ts`（`agents.create({ sessionId, meta: { cwd }, agentOptions })`）。

## 3. 操作面：handle 拿到后能对 Agent 做什么

官方类型面（node_modules/@deepseek-ai/dsh-agent/lib/types）暴露的动作：

| API | 语义 | 本项目 |
| --- | --- | --- |
| `agent.followup(message)` | 追加一轮任务（进 inbox、唤醒、不打断既有历史） | ✅ 两个会话都靠它派任务；任务文本本身可当能力开关（Jira 分析指令：「先调 `jira_get_issue` 取详情」「禁止写操作工具」） |
| `agent.whenIdle()` | 等会话静止（一个 turn 结束）；**模型失败也 resolve，不抛** | ✅ Jira 分析用它收口后扫日志判定成败 |
| `agent.cancel(cause)` | 中止运行 | ⬜ |
| `agent.steer(message)` | 打断当前思路并改方向 | ⬜ |
| `agent.send(message, target, wakeup)` | 定向发送，可选唤醒 | ⬜ |
| `agent.inject(message)` | 入队不唤醒（等当前 turn 结束再处理） | ⬜ |
| `agent.session` | 会话本体：`seq` 边界、事件读取（dev 运行面 `events` getter / rc.1 发布面 `snapshotEvents`，见 6 节坑）、标题、workspace 归属 | ✅ `boundary = session.seq` 后 followup，事后按 `[boundary, 末尾)` 取事件 |

inbox 队列原语（`claim`/`append`/`prepend`/`replace`/`remove`/`splice`/`commit`）是 Agent 团队 / 多入站目标场景的底层，本项目未直接接触。

## 4. 工具面：会话内 Agent 能调什么

Agent 的能力本质是它**可见的工具 + 系统提示**。dsh 的 tools 是作用域合并模型（ScopedLayers），本项目恰好验证了两种注入路径：

| 注入方式 | 工具 | 可见范围 | 代码 |
| --- | --- | --- | --- |
| **全局注册** | `jira_search_issues` / `jira_get_issue` / `jira_create_issue` / `jira_add_comment` / `jira_update_status` / `jira_get_transitions` | 所有会话可见 | `src/host/jira-tools.ts`，`apply` 顶层 `ctx.tools.register`（`src/host/index.ts`） |
| **作用域注册** | `google_news` | **仅该会话可见**，不污染全局 | 会话 `setup` 里 `installGoogleNewsTool(agentCtx)`（`src/host/news.ts`） |

推论：Jira 分析会话**无需 setup 注册工具** —— 全局层 `jira_get_issue` 通过 tools.view 的合并对会话可见；新闻会话的 `google_news` 只为此会话而生。两种形态对应两种意图：**服务型工具全局贡献、任务型工具会话私有**。

LLM 治理侧未触达：`ctx.systemPrompt`（系统提示 section 组装）、`ctx.tokenMeter`、工具结果裁剪、`agentDefaultModel`。工具注册的硬约束：`parameters` 必须是**完整 JSON Schema**（`type: 'object'` 顶层），简写会被模型 API 拒绝（dev-log 2026-08-31 条目）。

## 5. 运行模式：本项目的两种对照实证

| | 新闻会话（fire-and-forget） | Jira 分析会话（headless 回收） |
| --- | --- | --- |
| 驱动 | create → followup → **立即返回 sessionId** | create → followup → **await whenIdle()** |
| 结果回收 | 无（用户在 Web UI 看） | 事件边界后折叠最终文本 → 宿主 `emit('jira/analysis-done')` 经长轮询推前端 |
| 失败判定 | 不关心 | whenIdle 不抛，扫最后一条 `turn/end` 的 reason（error/aborted） |
| 会话组织 | 「新闻头条」workspace（cwd 工作区） | 「Jira 分析」workspace（插件包目录，独立分组） |
| 会话标题 | `sessionTitle.rename`「获取新闻 HH:mm:ss」 | 「分析 KEY HH:mm:ss」 |
| 结束处理 | 不 dispose | **不 dispose** —— 会话留在左侧可回放、可续聊（`agents.resume` 续聊） |

折叠最终文本的 headless 范式（`collectAnalysisText`）：遍历 `assistant/message`，text 块非空则覆盖「最终文本」—— 中间含 tool-call 的回合自然被跳过；`turn/end` reason 为 error/aborted 抛错兜底。

## 6. 未触达的能力与潜在用途

类型面与能力目录（catalog 2.1/2.2）暴露、本插件尚未使用的面：

| 类别 | 服务 | 潜在用途 |
| --- | --- | --- |
| 执行与编排 | `ctx.jobs`（bash/PTY/subagent 统一运行时）、`ctx.goals`、`ctx.agentLoop`（接管主循环） | Agent 跑脚本/命令的后台运行时、目标驱动推进、自定义循环策略 |
| 子代理 | `ctx.subagents`（配 `meta.origin`/`delegationDepth`）、`ctx.agentTeams`（实验） | 并行子任务、多 Agent 协作 |
| 会话数据 | `sessionPersistence`（jsonl/sqlite seam）、`sessionQuery`、`sessionProjections`、`sessionTelemetry` | 重启不丢会话、事件查询、聚合视图供 UI |
| 模型治理 | `agentDefaultModel`、`agentPresets`、`systemPrompt`、`tokenMeter` | 无配置时的模型兜底、预设模板、提示词组装、计费观测 |

## 7. 踩坑清单（Agent 相关）

1. **`whenIdle` 失败不抛**：模型调用失败时静默 resolve → 成败只能扫 `turn/end` reason（error/aborted）或听 `agent/error` 事件。
2. **`handle.dispose()` 会删除会话**（左侧工作区条目随之消失）→ 要让会话留下就别 dispose；新闻 / 分析会话都如此。
3. **工具 `parameters` 须完整 JSON Schema**：`tools.register` 直传简写被模型 API 拒（`defineTool` 会归一化，plain register 不会）。
4. **事件读取 API 版本错位**：harness 工作区源码运行面的 Session 是 `events` 快照 getter；已发布 rc.1 类型标注 `snapshotEvents(from, to)` —— 须特性探测择一（`snapshotEventsFrom` 辅助，dev-log 2026-09-09 条目）。
5. **事件边界按 `seq` 计**：followup 前记 `boundary`，回传扫描只取 `[boundary, 末尾)`，避免旧回合污染。

## 8. 下一步学习建议

Agent 已从「能聊天的 LLM」验证为**可编程执行体**：create 配置世界 → followup 派任务 → 事件日志作事实源 → whenIdle 收口。继续深入的方向按依赖关系排序：

1. `subagents`（分叉 + 预算）→ 并行子任务
2. `jobs`（bash/PTY 运行时）→ Agent 落地执行
3. `sessionPersistence` / `sessionQuery` → 会话跨重启与查询
4. `agentLoop` / `goals` → 自定义驱动循环
5. `agentTeams`（实验）→ 多 Agent 协作

对应练习路径见 [learning-path.md](learning-path.md)。
