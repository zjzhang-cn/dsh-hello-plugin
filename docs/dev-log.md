# 开发日志（Development Log）

> 规则：**每次功能 / BUG 修改 / 实现都要记录开发日志。** 记录在 `docs/dev-log.md`，一次功能或修复一条记录。按时间倒序（最新在上）。

## 2026-09-10 — 获取新闻按钮在 Agent 跑完前禁用（防重复点击）

**类型**：功能
**涉及**：`src/host/index.ts`、`src/client/components/HelloPill.tsx`、`src/client/components/NewsButton.tsx`、`src/client/components/NewsStatus.tsx`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：`news/start` 是「发起即返回 `{ sessionId }`」的端点，客户端在 RPC `.finally()` 里就把 `newsLoading` 置回 false —— 按钮只在一次 HTTP 往返内禁用，Agent 还在后台跑时就能继续点击，容易误开多个新闻会话。
**改动**：
- 宿主 `news/start`：`followup` 后追加 `void handle.agent.whenIdle().then(() => emit('news/done', [{ sessionId }])).catch(...)` → 失败推 `news/failed` + `message`。复用既有长轮询事件链路（与 `jira/analysis-*` 同款），会话仍不 dispose（保留在「新闻头条」工作区）。`whenIdle` 对模型失败静默 resolve，故成功/失败都以 `whenIdle` 返回为解除信号。
- 客户端 `HelloPill`：新增 `pendingNewsSessionRef`；`news/start` 成功时只记录并展示 `sessionId`，**不再在 `.finally()` 取消 loading**（仅错误分支立即恢复）；poll 循环新增 `news/done` / `news/failed` 分支，按 `sessionId` 匹配 `pendingNewsSessionRef` 才 `setNewsLoading(false)`（旧会话事件丢弃，防止提前放行）。
- **竞态兜底**：结束事件与 `news/start` 响应走两条不同的 HTTP 连接，顺序无保证 —— 若 `news/done` 先到会被「不匹配就丢弃」逻辑吃掉，按钮将永久禁用。故新增 `settledNewsRef`（暂存最近 5 条「先到的结束事件」），`startNewsSession` 拿到 `sessionId` 后回查该暂存并按结果立即解除禁用（含失败文案）。
- `NewsButton`：禁用时 `cursor: not-allowed` + `opacity 0.75`，文案「正在获取…」，title 说明结束后可再次点击。
- `NewsStatus`：新增 `newsLoading` prop —— 运行中蓝色「⏳ Agent 正在获取新闻（会话 …），完成后按钮恢复可点击」，结束后绿色「✅ 已创建会话 …」。
**验证**：`pnpm build`（双 tsconfig + tsdown）与 `node --check lib/host.js` 通过；`lib/host.js` 含 `news/done` / `whenIdle`，`lib/client.js` 含 `news/failed` 分支。运行时需在挂载本 bundle 的 profile 点击 📰 验证：点击后按钮持续禁用，Agent 结束后（宿主日志 `emit: news/done`）恢复可点击。

## 2026-09-10 — 修复「获取新闻」按钮不恢复：状态看门狗 + 长轮询超时

**类型**：BUG 修复
**涉及**：`src/host/index.ts`、`src/host/types.ts`、`src/client/components/HelloPill.tsx`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：用户实测点击「📰 获取新闻」后按钮一直停在「正在获取…」，即使 Agent 会话已 `turn/end` 也不恢复。
**定位**（实测，非推断）：
- 用 `~/.dsh/.credentials.yaml` 里的 browser-session secret 自签 `dsh-auth-*` cookie，直接 POST `/hello/*` 打通宿主链路（`ping` → pong、`/plugins/??…dsh-hello-plugin/client.js` 组合包内容含 `news/done`/`settledNewsRef`，确认浏览器加载的客户端是新代码）。
- 实测 `news/start` + 反复 `events/poll`：会话结束后宿主**确实**推了 `news/done`（`{"event":"news/done","args":[{"sessionId":"news-7e2d20ed-…"}]}`）⇒ 宿主半区正常，问题在事件投递/客户端。
- 结论：按钮恢复只依赖「单条长轮询事件」，该链路任何一次中断都会让按钮永久禁用 —— 尤其宿主重启会把浏览器在飞的长轮询请求悬住：`inflight` 在 `await` 前已置 true，请求若不 settle，轮询循环再也不会发下一次，事件全部积压在宿主队列里。
**改动**：
- 宿主新增 `/hello/news/status` 端点：内存维护最近一次新闻会话的权威状态 `latestNews = { sessionId, state: 'running'|'done'|'failed', error? }`（`NewsStatus` 类型入 `src/host/types.ts`）；`news/start` 建会话时置 running，`whenIdle` 收敛为 done / failed，建会话失败也置 failed（避免永远停在 running）。
- 客户端三条恢复路径互为兜底：① 事件（原有，sessionId 匹配 + 先到事件暂存）；② **看门狗**：禁用期间每 3 秒 `/hello/news/status`，与未决 id 匹配且状态非 running 就恢复（事件丢失、运行途中刷新页面、宿主重启都能收敛；宿主重启导致状态为空时，未决 id 确立满 6 秒仍无记录即按结束处理）；③ **请求超时**：`events/poll` 带 `AbortSignal.timeout(20s)`、`news/start` 带 30s，超时走既有 catch 重试，`inflight` 不会永久卡死；另挂载时同步一次状态（运行途中刷新页面仍显示禁用）。
- `settleNews` 要求未决 id 存在且匹配才收敛（否则刚点击、sessionId 未回来时上一轮的 done 会提前放开按钮）。
**验证**：`pnpm build` 双半区通过、`node --check lib/host.js` 通过；自签 cookie 实测宿主 `news/start` → 10s 后 `news/done` 事件、且新端点 `/hello/news/status` 可读（**需重启 dsh web 才加载新宿主 bundle**；旧宿主对 `news/status` 返回 `bad-request: unknown endpoint`，此时看门狗自动退化为仅靠事件）。

## 2026-09-10 — 修复 /hello 通道不可用：`rpc.handle` 缺陷 → 自建 web 通道

**类型**：BUG 修复
**涉及**：`src/host/web-channel.ts`（新增）、`src/host/index.ts`、`src/host/constants.ts`、`package.json`、`pnpm-lock.yaml`、`CLAUDE.md`、`AGENTS.md`、`README.md`、`docs/dev-log.md`、`docs/plugin-dev-handbook.md`、`docs/plugin-capability-catalog.md`、`docs/hello-plugin-capabilities.md`
**背景 / 问题**：两个连续现象 —— ① `dsh web --patch …` 启动失败：`failed to apply loader entry dsh-hello-plugin: cannot get property "webServer" without inject`（抛在 `packages/client/connection/src/rpc-host.ts:179`）；② 加依赖/改作用域注册后启动通过，但浏览器点击报 `transport failure for /hello/news/start: HTTP 405`。
**定位过程**（均实测，非推断）：
- 405 探针：`POST /hello/ping` → 405、`GET /hello/ping` → 404 ⇒ `/hello` 前缀路由根本没挂上（405/404 来自 frontend-static 兜底）。
- 插桩：`ctx.inject(['connection','webServer'], cb)` 的**回调执行了**且 `webCtx.webServer` 可解析，但 `rpc.handle` 内部抛错（被 cordis 静默吞掉）—— 捕获到同一句 `cannot get property "webServer" without inject`。
- 读源码定性：`register()` 用 `owner.effect(() => owner.webServer.register(route))`，而 `owner = this.ctx` = **构造 `HostConnectionService` 时传入的 connection 插件 ctx**（`inject` 只有 `credentials`，"scoped to the reading Context" 的注释与实际不符）→ 解析起点是 connection 的 fiber，**消费方无论怎样声明依赖都无法满足**；connection 自挂 `/api` 走的是 `ctx.inject(['webServer'], webCtx => webCtx.effect(…))`，所以只有它自己能用。属 harness 侧缺陷（本仓库不改 harness）。
**改动**：
- 新增 `src/host/web-channel.ts`：`mountHelloChannel(ctx, handler)` 在**插件自己的 `ctx.webServer`** 上注册 `/hello` 前缀路由，行为对齐 harness 的 `rpcFetchHandler` + `bridge` —— ① `connection.requestRejection(req)` 做 Host/Origin + 浏览器 cookie 栅栏（403/401，拒绝响应与 connection 自挂 `/api` 逐字一致）；② 方法/内容类型/信封校验（404/415/400）与 1 MiB 请求体上限（413）；③ 端点解析规则与 `endpointFromPath` 相同（段模式 `[A-Za-z0-9_$.-]+`）；④ `res` close → `AbortController` 中止 handler（长轮询在页面关闭时释放）；⑤ 编解码 Connection RPC 信封（`{type:'client-request',rpcId,method,payload}` ↔ `{type:'server-response',rpcId,result}`）。
- `src/host/index.ts`：`handleHello` 改由 `mountHelloChannel(ctx, handleHello)` 挂载；`src/host/constants.ts`：`inject` 增加 `webServer` 并补注释；`package.json`：新增类型依赖 `@deepseek-ai/dsh-host-webserver`（peer + dev，type-only，用于 `ctx.webServer` 的模块增强类型）。**客户端半区零改动**（仍走 `connection.rpc.call('/hello', …)`）。
**验证**：`pnpm build` 通过；`dsh web --patch … --port 3099` 实测（避开 3080 上已有实例）：① 无 cookie POST → 401；② 用启动 URL 的 `?token=` 换取浏览器 cookie（303）后 POST `/hello/ping` → `{"ok":true,"value":"pong from host, hello probe!"}`；③ `/hello/jira/todos` → 正常的 `jira-not-configured` 错误信封；④ `/hello/events/poll` → 立即取回挂起的 `hello/notice` 事件。验证后已关闭实例。

## 2026-09-09 — 新增「dsh AGENT 插件」文档

**类型**：文档
**涉及**：`docs/agent-plugin.md`（新增）、`CLAUDE.md`、`AGENTS.md`、`README.md`、`docs/agent-capabilities.md`、`docs/dev-log.md`
**背景 / 问题**：hello-plugin 一直在用 `ctx.agents`，但缺少对「它本身也是一个 Cordis 插件」（`@deepseek-ai/dsh-agent`）的独立说明 —— 注册表、句柄、initiator scope、agent/* 事件、与 agent-loop 的分层关系散落在 harness 源码与 README 里。
**改动**：
- 新建 `docs/agent-plugin.md`（9 节）：包定位（提供四样东西、零循环依赖）；**registry / agent-loop 双层架构**（create 委托注册的 factory、最小组合两者同挂、enter→announce 可回滚发布）；peer 依赖底座（session / llm / tools / scope / system-prompt / typert / cordis）解释 agentCtx 作用域现象；`ctx.agents` 服务 API 全表（create/resume/get/list/roots/isOwnedBy/register/enter/announce/withInitiator/setFactory）；Agent 控制面（dispose 副作用 = 删会话、followup/steer/inject/send/cancel/whenIdle 精确差别）；`agent/*` 事件插桩缝（pre-step / request-error / turn-stopping / status / inbox）；源码地图（src 各文件角色）；与 hello-plugin 的使用界面对照；学习下一步。
- `docs/agent-capabilities.md` 头部补与本文的分工指针；CLAUDE.md / AGENTS.md 布局与 README 结构表补行；README 开发日志简述同步。
**验证**：Markdown 渲染检查；peer 依赖表与 API 表核证 harness `packages/core/agent` 源码与官方 README，npm 包装内容核证 node_modules（含运行时 lib/index.js，hello-plugin 侧 type-only）。

## 2026-09-09 — 新增「Agent 能力分析」文档

**类型**：文档
**涉及**：`docs/agent-capabilities.md`（新增）、`CLAUDE.md`、`AGENTS.md`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：capability-catalog（全目录）与 hello-plugin-capabilities（使用全景）都是清单式，缺一份聚焦 Agent 能力面的机制深潜，回答「一次 `agents.create()` 后 Agent 能做什么、怎么控制、还差什么」。
**改动**：
- 新建 `docs/agent-capabilities.md`，以新闻 / Jira 分析两类 Agent 会话与官方 `dsh-agent` 类型面为据分 8 节：
  - 基本模型（Agent = 会话执行体，事件日志是唯一事实来源）、创建面 `CreateAgentOptions` 实证表（sessionId / meta.cwd / agentOptions / setup 已用；subagent fork / seed 未用）
  - handle 操作面（followup / whenIdle 实证；cancel / steer / send / inject 未用）、工具面（全局 `jira_*` vs 作用域 `google_news` 两种注入对照）、两种运行模式（新闻 fire-and-forget vs Jira headless 回收）
  - 未触达能力（jobs / goals / agentLoop / subagents / agentTeams / 会话数据层 / 模型治理）与潜在用途、踩坑清单、下一步学习建议
- 文档间的分工说明放文档头部；CLAUDE.md / AGENTS.md 布局与 README 结构表补该文档行；README 开发日志简述同步。
**验证**：Markdown 渲染检查；文档内引用的源码路径与既有文档风格一致。

## 2026-09-09 — dsh 依赖范围对齐已发布的 0.1.2-rc.1

**类型**：重构 / 依赖维护
**涉及**：`package.json`、`pnpm-lock.yaml`
**背景 / 问题**：peer + dev 中 `@deepseek-ai/dsh-*` 十个包仍声明 `^0.1.2-alpha.2`，而 dsh 已发布 0.1.2-rc.1（lock 实际解析的也是 rc.1）—— 声明范围滞后于真实版本面。
**改动**：package.json 中 `dsh-agent / dsh-llm / dsh-session / dsh-session-title / dsh-tools / dsh-workspace / dsh-client-connection / dsh-client-ui-layout / dsh-client-ui-renderer / dsh-settings` 的 peerDependencies 与 devDependencies 范围由 `^0.1.2-alpha.2` 全部改为 `^0.1.2-rc.1`（保留 caret）；`pnpm install` 同步 lockfile。
**验证**：`pnpm typecheck` / `pnpm build` 通过；`node --check lib/host.js` 通过；lockfile 无 alpha.2 残留，安装版本仍为 0.1.2-rc.1。

## 2026-09-09 — 修复 Session 事件读取 API 版本错位（events vs snapshotEvents）

**类型**：BUG 修复
**涉及**：`src/host/jira-agent.ts`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：官方类型化后按已发布 0.1.2-rc.1 的类型标注调用 `agent.session.snapshotEvents(boundary)`，运行时实测报 `snapshotEvents is not a function`——dev profile 跑的是 harness 工作区源码（packages/core/session 的 Session 提供 `get events(): readonly SessionEvent[]`，src/index.ts:557），并无 `snapshotEvents`；发布版 rc.1 类型与源码 API 错位（rc.1 标注 `snapshotEvents(from, to)`、无 `events` getter，装上的 devDep 即此版本）。
**改动**：`src/host/jira-agent.ts` 新增 `snapshotEventsFrom(session, boundary)` 特性探测辅助：优先用 `events` 快照 getter（`events.slice(boundary)`，harness 源码运行面），其次回退 `snapshotEvents(boundary)`（rc.1 发布类型面），两者皆无则抛错。取事件范围语义一致（[boundary, 日志末尾)）。
**验证**：`pnpm typecheck` / `pnpm build` / `node --check` 通过；dsh profile 实测分析会话正常完成并推送 `jira/analysis-done`。

## 2026-09-09 — 服务类型改用官方 @deepseek-ai/* 包，删除手写结构接口与 cast

**类型**：重构
**涉及**：`package.json`、`pnpm-lock.yaml`、`src/host/jira-agent.ts`、`src/host/index.ts`、`src/host/jira-tools.ts`、`src/host/news.ts`、`CLAUDE.md`、`AGENTS.md`、`docs/dev-log.md`
**背景 / 问题**：宿主为调用 harness 服务（agents / sessionTitle / workspaceRegistry / tools）手写了结构接口与大量类型强转（`AgentsServiceLike`、`AgentLike`、`SessionLike`、`SessionEventLike`、`ToolRegistry`、workspaceRegistry/sessionTitle 内联结构、`as never` 等），而这些类型 harness 均已发布为 `@deepseek-ai/*` npm 包并提供 cordis `Context` 模块增强。
**改动**：
- `package.json`：peer + dev 各加 `@deepseek-ai/dsh-agent | dsh-session | dsh-tools | dsh-workspace`（与既有 `^0.1.2-alpha.2` 写法一致，lock 解析 0.1.2-rc.1；`dsh-session-title` 此前已加）。全部 **type-only** 使用，无新增运行时依赖。
- `src/host/jira-agent.ts`：删除 4 个手写结构接口，改 `import type` 官方 `AgentRegistry` / `SessionEvent` / `SessionId` / `WorkspaceRegistry` / `ContentBlock`（dsh-llm）；服务获取按 dsh-agent-teams 惯例 `ctx.get(...) as 官方类型 | undefined`；`agents.create` 的 `sessionId as never` → `sessionId as SessionId`（brand，仅类型层）；`sessionTitle.rename` 直调（官方增强类型）；事件折叠改用 **SessionEvent 判别联合**（`turn/end` 的 `reason`、`assistant/message` 的 `message.content` 不再逐层 `as` 收窄）；会话日志读取从 `session.events.slice(boundary)` 改为 rc.1 实际 API `session.snapshotEvents(boundary)`。
- `src/host/index.ts`：news/start 的 workspaceRegistry 内联结构 → `WorkspaceRegistry` 官方类型；sessionTitle 结构 cast → `ctx.sessionTitle.rename(...)` 直调（`import type {} from '@deepseek-ai/dsh-session-title'` 载入增强）；`attachSession` 补 `SessionId` brand 断言。
- `src/host/jira-tools.ts` / `src/host/news.ts`：删除 `ToolRegistry` 接口与 `jiraToolRegistry`/agentCtx 结构 cast，6+1 个工具定义改为 `ToolDefinition` 数组/标注后 `ctx.tools.register(...)`（工具 schema 字面量经官方类型校验，运行时语义不变）。
- 保留的本地址义：Jira/新闻领域模型、长轮询信封（PendingEvent/HelloEvent）、组件 props 等 —— dsh 无对应物。
**验证**：`pnpm typecheck` / `pnpm build` 通过（判别收窄与 ToolDefinition 字面量零报错）；`node --check` 通过；`lib/host.js` 对五个新包无运行时 import（仅注释残留）；运行期行为不变，实测步骤同 README「开发与验证」。

## 2026-09-09 — README 新增「Jira 业务流程一览」章节

**类型**：文档
**涉及**：`README.md`、`docs/dev-log.md`
**背景 / 问题**：README 的 Jira 描述按机制分节（配置 / 待办 / 分析 / 评论 / 工具），使用者视角的「整条业务怎么走」需要自行拼装。
**改动**：README 在「快速验证」与「架构」之间新增「Jira 业务流程一览」：以四条链路为主线（前提配置 → 浏览待办 → 点击发起 Agent 会话分析并异步回传确认评论 → 会话内 jira_* 工具自由操作），每条标注参与者与关键端点，另附错误语义速查表。
**验证**：README 渲染检查（表格与列表结构完整、与机制章节口径一致）。

## 2026-09-09 — Jira 分析改为 Agent 会话：左栏「Jira 分析」工作区 + 结果长轮询回传

**类型**：功能（重构）
**涉及**：`src/host/jira-agent.ts`（新建）、`src/host/jira.ts`、`src/host/index.ts`、`src/host/llm.ts`（删除）、`src/client/components/HelloPill.tsx`、`src/client/components/AnalysisPanel.tsx`、`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/hello-plugin-capabilities.md`、`docs/plugin-dev-handbook.md`
**背景 / 问题**：`jira/analyze` 经 `generateLlmAnalysis` 直连 `ctx.llm.stream` 生成分析文本——LLM 交互不可见、无会话记录；希望分析在 Agent 会话中完成、会话显示在左侧工作区，且分析完成后仍由前端询问是否添加到评论。
**改动**：
- 删除 `src/host/llm.ts`，新增 `src/host/jira-agent.ts`：`runJiraAnalysisSession` 创建会话（sessionId `jira-<uuid>`，agentOptions 取 `llm.config.json`）→ `workspaceRegistry.create(插件包根目录, 'Jira 分析')` + `attachSession`（独立分组，与「新闻头条」按不同目录路径并存）→ `sessionTitle.rename`「分析 KEY HH:mm:ss」→ `followup`（任务要求先调全局可见的 `jira_get_issue` 工具取完整详情再输出分析，并禁止写操作工具）→ `agent.whenIdle()` 等静止 → 扫 `session.events`（followup 前的 `seq` 边界之后）折叠最终文本（`assistant/message` 非空 text 逐条覆盖；`turn/end` reason 为 error/aborted 视为失败）。会话**不 dispose**，保留在左侧可查看/续聊。
- `src/host/jira.ts` 新增 `fetchJiraIssueSummary`（`getIssue` 仅取 summary 字段）：会话创建前轻量预检（校验 Jira 配置与 issue 存在），为会话标题 / 任务消息提供摘要。
- `src/host/index.ts` 的 `jira/analyze` 改为**异步发起**：预检（缺 provider/model → `llm-not-configured`；agents 缺失 → `agents-unavailable`；预检失败 → `jira-not-configured` / `jira-error`）→ fire-and-forget 启动会话 → **立即返回 `{ sessionId }`**；完成 / 失败分别经 `events/poll` 长轮询推送 `jira/analysis-done`（`{ key, summary, analysis, sessionId }`）/ `jira/analysis-failed`（`{ sessionId, message }`）。
- 客户端：`HelloPill` 长轮询由「只留最新气泡」改为**按事件名分发**——`jira/analysis-done` / `jira/analysis-failed` 仅在 `sessionId` 匹配最近一次未决请求时生效（防旧会话结果覆盖新点击），其余事件维持气泡；loading 提示改为「Agent 正在分析…」；`AnalysisPanel` 新增 `sessionHint` prop 展示会话提示。
**验证**：`pnpm build`（双半区类型检查）+ `node --check lib/host.js lib/client.js` 通过；bundle 含新会话逻辑。运行期验证（点击待办 → 左侧「Jira 分析」分组出现会话 → 完成后推送 → 面板「添加到评论」写回）需在挂载本 bundle 的 dsh profile 实测，步骤见 CLAUDE.md / README「开发与验证」。

## 2026-09-04 — README 新增「验证过的 dsh 能力」章节

**类型**：文档
**涉及**：`README.md`、`CLAUDE.md`、`AGENTS.md`、`docs/dev-log.md`
**背景 / 问题**：README 缺少对「本插件实际验证了 dsh 哪些能力」的概括；详细清单（`docs/hello-plugin-capabilities.md`）存在但无入口，且 CLAUDE.md / AGENTS.md 的 docs 布局未列出该文档。
**改动**：
- README 在「本机 Chrome 调试远端客户端」后新增「验证过的 dsh 能力」：表格概览已实际使用 10 项能力（双面模型/加载、Cordis 内核、Unary RPC、长轮询、Agent 会话、作用域工具、LLM 直连、会话命名/工作区、settings 与工程配置、插槽 UI），每项附「插件里的体现 + 顺带验证的约束」；并说明刻意未用的 3 类通道及选型理由。
- README 结构表补充 `docs/hello-plugin-capabilities.md`；CLAUDE.md / AGENTS.md 的 docs 布局补该文档行。
**验证**：README 渲染检查；链接锚点指向「客户端调用宿主」与「宿主主动推送到客户端（长轮询）」章节。

## 2026-09-02 — jira.ts 改用 jira.js v5 官方客户端（修复 410 弃用端点）

**类型**：重构 + BUG 修复
**涉及**：`src/host/jira.ts`、`package.json`
**背景 / 问题**：
1. `jira.ts` 中所有 Jira API 调用均手写 `fetch` + URL 拼接 + 手动解析 JSON，代码冗长且缺乏类型安全；Atlassian 官方提供 `jira.js` 库，支持 TypeScript，API 覆盖完整。
2. **升级后发现问题**：`jira.js` v3.0.5 的 `searchForIssuesUsingJql` 内部调用 `/rest/api/3/search`，该端点已被 Jira Cloud 弃用（410 Gone），须用 `/rest/api/3/search/jql`。
**改动**：
- 安装 `jira.js` v5.4.0（`Version3Client`）。
- `jira.ts` 移除 `jiraHeaders`、`jiraApiError` 等内部 fetch 辅助函数。
- 新增 `createJiraClient(settings)` 构造器，返回配置好 `host` + `basic` 认证的 `Version3Client`。
- 7 个导出函数改用 `jira.js` API：
  - `fetchJiraTodos` / `searchJiraIssues` → `client.issueSearch.searchForIssuesUsingJqlEnhancedSearch`（新端点 `/rest/api/3/search/jql`）
  - `fetchJiraIssueDetail` → `client.issues.getIssue`
  - `addJiraComment` → `client.issueComments.addComment`
  - `createJiraIssue` → `client.issues.createIssue`
  - `getJiraTransitions` → `client.issues.getTransitions`
  - `transitionJiraIssue` → `client.issues.doTransition`
- 保持函数签名不变，`index.ts` 与 `jira-tools.ts` 零改动。
**验证**：`pnpm build` 通过（host/client 双半区无类型错误）；`node --check lib/host.js` 通过。

## 2026-09-01 — fetchGoogleNews 支持 HTTP 代理

**类型**：功能
**涉及**：`src/host/news.ts`
**背景 / 问题**：`fetchGoogleNews` 直接用 Node 全局 fetch 抓 Google News RSS，未走代理；在只能经 HTTP 代理访问外网的网络环境下（如本机 `https_proxy=http://127.0.0.1:8080`）抓取超时失败。
**改动**：
- 新增按 curl 语义解析代理环境的 `resolveProxy`：`HTTPS_PROXY`/`HTTP_PROXY`（兼容小写）→ `ALL_PROXY`，目标命中 `NO_PROXY`（支持 `*`、精确主机、`.后缀` 子域、`host:port`）时直连。
- 新增代理链路（纯 Node 内建 `node:net` / `node:tls`，不引入新运行时依赖）：https 目标走 CONNECT 隧道（支持 http/https 代理与 Basic 认证）再包 TLS；http 目标向代理发绝对 URI 形式请求；手写 HTTP 解析（状态行/头/body，含 chunked 解码、Content-Length 提前收尾、`Connection: close` 收尾）并手动跟随重定向（上限 5 次）。
- `fetchGoogleNews` 改为经 `fetchWithProxy`：无代理时行为与原来完全一致（全局 fetch + 10s 超时）。
**验证**：`pnpm build` / `node --check lib/host.js` 通过；真实环境（`https_proxy=http://127.0.0.1:8080`）抓取 Google News 成功（跟随 302 后返回 13 条）；本地最小代理 + 本地 https/http 目标跑通 10 项用例：CONNECT 隧道、302 跟随、chunked、404、重定向上限、https→http 绝对 URI 形式、NO_PROXY 直连、无代理直连、代理 Basic 认证、代理拒绝连接报错。

## 2026-09-01 — 扩展 Jira 能力并注册全局工具

**类型**：功能
**涉及**：`src/host/jira.ts`、`src/host/jira-tools.ts`、`src/host/index.ts`
**背景 / 问题**：hello-plugin 的 Jira 功能仅覆盖「查询待办」「获取详情」「添加评论」，Agent 无法通过工具调用的方式操作 Jira（如搜索任意 JQL、创建 issue、更新状态）。
**改动**：
- `src/host/jira.ts` 新增 4 个函数：`searchJiraIssues`（JQL 搜索）、`createJiraIssue`（创建）、`getJiraTransitions`（获取可用状态变更）、`transitionJiraIssue`（执行状态变更）。
- 新建 `src/host/jira-tools.ts`，定义 6 个 Jira 工具的 `ToolDefinition`，通过 `ctx.tools.register` 注册为全局工具：
  - `jira_search_issues`、`jira_get_issue`、`jira_create_issue`、`jira_add_comment`、`jira_update_status`、`jira_get_transitions`
- `src/host/index.ts` 导入 `registerJiraTools` 并在 `apply()` 中调用注册。
**验证**：`pnpm typecheck` 通过；工具注册代码与 `google_news` 工具模式一致。

## 2026-09-01 — 新建 hello-plugin dsh 能力全景文档

**类型**：文档
**涉及**：`docs/hello-plugin-capabilities.md`
**背景 / 问题**：hello-plugin 已使用了多种 dsh 能力（RPC、插槽、Agent、LLM、工具注册等），但缺少一份系统的全景视图，开发者难以快速了解「已用了什么、还有什么可用」。
**改动**：
- 新建 `docs/hello-plugin-capabilities.md`，按 `plugin-capability-catalog.md` 的类别体系梳理：
  - 6 大类别（Cordis 内核、宿主端核心服务、客户端核心服务、双向通信、插槽与 UI、工具贡献）
  - 每个能力标注「已使用 ✅ / 未使用 ⬜」
  - 已使用的附源码位置和使用场景
  - 未使用的附潜在用途
- 已使用 10 项：logger/effect/get、settings/workspaceRegistry、agents/sessionTitle、llm/tools、connection/slots、Unary RPC/长轮询、shell.overlay、tools.register
- 未使用 50+ 项：fs/shell/web、commands/approval、remote/layout/theme、Remote events/WebSocket mux 等
**验证**：文档结构与 `plugin-capability-catalog.md` 对齐，源码位置可定位。

## 2026-09-01 — 新增 AGENTS.md 并修正 CLAUDE.md 入口文件路径

**类型**：文档
**涉及**：`AGENTS.md`、`CLAUDE.md`
**背景 / 问题**：hello-plugin 缺少给 AI agent 看的项目级开发指南；CLAUDE.md 中客户端入口文件路径仍写为 `src/client/index.tsx`，与实际拆分为 `index.ts` + `components/` 的结构不一致。
**改动**：
- 新增 `AGENTS.md`，包含 Repository layout、Commands、Conventions、Defensive patterns、Type safety and documentation 五个章节。
- 修正 `CLAUDE.md` 中「客户端半区」描述，`src/client/index.tsx` → `src/client/index.ts`；补充 Panel 组件和最小化行为的 UI 插槽说明。
**验证**：确认 `AGENTS.md` 和 `CLAUDE.md` 内容准确反映当前代码结构。

## 2026-09-01 — 按功能模块拆分 client 和 host 源码

**类型**：重构
**涉及**：`src/client/*`、`src/host/*`、`tsconfig.client.json`、`tsconfig.host.json`、`tsdown.config.ts`
**背景 / 问题**：client 和 host 的源码分别集中在单个文件中（424 行和 617 行），随着功能增加，单个文件变得臃肿，可读性和可维护性下降。
**改动**：
- Client：按 UI 组件维度拆分为 `types.ts` + `components/` 下的 `TodoItem.tsx`、`TodoCard.tsx`、`AnalysisPanel.tsx`、`EventBubbles.tsx`、`NewsStatus.tsx`、`NewsButton.tsx`、`HelloButton.tsx`、`HelloPill.tsx`，入口 `index.ts` 仅负责插槽注册。
- Host：按功能域拆分为 `types.ts`、`constants.ts`、`errors.ts`、`config.ts`、`jira.ts`、`llm.ts`、`news.ts`，入口 `index.ts` 仅负责整合与 RPC 注册。
- 两个 tsconfig 的 `moduleResolution` 统一改为 `Bundler`，避免内部模块导入时强制写 `.js` 扩展名。
- `tsdown.config.ts` 的 client 入口从 `.tsx` 改为 `.ts`。
**验证**：`pnpm build` / `pnpm typecheck` 通过；各模块文件无编译错误。

## 2026-08-31 — 工作区分组「新闻头条」，会话标题复原

**类型**：功能
**涉及**：`src/host/index.ts`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：用户希望 Web UI 里新闻会话按「新闻头条」工作区分组显示，而会话标题保持原样（「获取新闻 + 时间」）。
**改动**：`inject` 增加 `workspaceRegistry`；`news/start` 中 `workspaceRegistry.create(cwd, '新闻头条')` 创建/复用工作区（`setTitle` 固定显示名）→ `attachSession(sessionId)` 把会话归入该工作区；会话标题从「新闻头条 <时间>」改回「获取新闻 <时间>」。
**验证**：`pnpm typecheck` / `pnpm build` 通过；bundle 含工作区创建、attachSession 与会话标题逻辑。

## 2026-08-31 — 新闻会话分组名称改为「新闻头条」

**类型**：功能
**涉及**：`src/host/index.ts`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：会话标题前缀「获取新闻」不够醒目，用户希望分组名称为「新闻头条」。
**改动**：`news/start` 的 `ctx.sessionTitle.rename` 标题从「获取新闻 <HH:mm:ss>」改为「新闻头条 <HH:mm:ss>」；README 简述与机制描述同步更新。
**验证**：`pnpm build` 通过；bundle 含「新闻头条」标题逻辑。

## 2026-08-31 — 新闻会话命名「获取新闻 + 时间」

**类型**：功能
**涉及**：`src/host/index.ts`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：新闻会话在会话列表中无明确标题，需要一眼可辨。
**改动**：`inject` 增加 `sessionTitle`；`news/start` 创建会话后调用 `ctx.sessionTitle.rename(session, '获取新闻 <HH:mm:ss>')`（追加 `session/title` 事件，固定标题并显示在会话列表）。类型经断言访问（session-title 模块扩展未引入插件编译面）。
**验证**：`pnpm typecheck` / `pnpm build` 通过；bundle 含会话标题逻辑。

## 2026-08-31 — 获取新闻入口从待办卡片独立为悬浮按钮

**类型**：功能
**涉及**：`src/client/index.tsx`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：「📰」按钮与新闻提示条原本嵌在待办卡片 header 与卡片内部，与待办功能耦合。
**改动**：从待办卡片移除 📰 按钮与新闻提示条；悬浮区域新增独立按钮组 —— 「📰 获取新闻」按钮（青色，请求中显示「获取中…」）与 hello 按钮并列一行，新闻成功/错误提示条独立显示在按钮上方。
**验证**：`pnpm build` / `pnpm typecheck` 通过；bundle 含独立新闻按钮文案。

## 2026-08-31 — 修复 google_news 工具 schema 被模型 API 拒绝

**类型**：BUG 修复
**涉及**：`src/host/index.ts`
**背景 / 问题**：Agent 会话中调用 `google_news` 工具时报 `Invalid schema for function 'google_news': schema must be a JSON Schema of 'type: "object"', got 'type: null'`。
**改动**：`parameters` 从简写 `{ locale: {...} }` 改为完整 JSON Schema `{ type: 'object', additionalProperties: false, properties: { locale: {...} } }`。根因：tool-web 等工具走 `defineTool`（内部 `parameterSchemaSpecToJsonSchema` 归一化），本插件直接 `tools.register` 传简写，模型 API 收到顶层无 type 的 schema 被拒。
**验证**：`pnpm build` / `pnpm typecheck` 通过；bundle 中 parameters 为完整 object schema。

## 2026-08-31 — 客户端点击发起新会话：Agent 获取 Google 新闻并总结

**类型**：功能
**涉及**：`src/host/index.ts`、`src/client/index.tsx`、`README.md`、`docs/dev-log.md`
**背景 / 问题**：在 client 发起一个点击请求 → 宿主发起一个新会话 → 会话功能是通过 Agent 获取最新 Google 新闻并总结，LLM 交互信息都在新会话中进行（dsh Web UI 会话列表可见）。
**改动**：
- **宿主**：新增 `/hello/news/start` 端点 —— `ctx.agents.create()` 创建新会话（sessionId `news-<uuid>`，agentOptions 取 `llm.config.json` 的 provider/model）→ `setup` 里注册作用域工具 `google_news`（fetch Google News RSS，正则解析 title/link/pubDate，取前 15 条）→ `agent.followup()` 让 Agent 获取新闻并总结 → 不 await whenIdle（会话后台运行，用户可在 Web UI 实时查看）。
- **工具作用域**：`ctx.tools.register` 走 `ScopedLayers` —— 从 agentCtx 调用仅该会话的 Agent 可见，不污染全局。
- **客户端**：待办卡片头部新增「📰」按钮（loading 时变 …）→ 调 `news/start` → 卡片下方显示「✅ 已创建会话 <id>，在会话列表查看 Agent 总结」或红色错误条。
- **会话可见性**：宿主创建会话自动触发 `api-session/added` Remote 事件，dsh Web UI 会话列表自动出现新会话，点开可见完整 LLM 交互（user/message → google_news 工具调用 → assistant 总结）。
**验证**：`pnpm build` 与双半区类型检查通过；`node --check lib/host.js` 通过；bundle 含 `google_news` 与 `news/start`；Google News RSS 真实抓取解析正常（15 条）；实际链路需在挂载本 bundle 的 dsh profile 中点击 📰 验证。

## 2026-08-31 — LLM 分析与评论（点击待办 → 分析 → 确认写回 Jira）

**类型**：功能
**涉及**：`src/host/index.ts`、`src/client/index.tsx`、`tsdown.config.ts`、`package.json`、`.gitignore`、`llm.config.json`（新增，gitignore）、`llm.config.example.json`（新增）、`README.md`、`CLAUDE.md`、`docs/dev-log.md`
**背景 / 问题**：点击待办事项后，希望把内容提交 LLM 分析，LLM 正式回答后询问是否添加到工作项评论，同意则写入 Jira。
**改动**：
- **宿主**：新增 `/hello/jira/analyze`（args `{ key }`）—— 取 issue 详情（summary + description + 已有评论，**ADF 递归转纯文本**）→ 调 `ctx.llm.stream`（`BlockAssembler` 聚合 `text-delta`，`finish.kind` 为 error/aborted 视为失败）→ 返回 `{ key, summary, analysis }`；`ctx.get('llm')` 可选获取，缺失返回明确错误。新增 `/hello/jira/comment`（args `{ key, text }`）—— `POST /rest/api/3/issue/{key}/comment`，body 用 **ADF 格式**（`{ type: 'doc', ... }`）。
- **LLM 配置**：工程根 `llm.config.json`（provider / model，已 gitignore）+ 可提交模板 `llm.config.example.json`；host 从 bundle 目录向上逐级查找（复用 `loadProjectJsonConfig` 通用化）。
- **构建**：`@deepseek-ai/dsh-llm` 改为 **external**（其 attribution 模块用 `createRequire(import.meta.url)("../package.json")` 读自身版本，内联会导致相对路径错位），并移入 `dependencies`（运行时依赖）；host bundle 回到 ~43KB。
- **客户端**：待办项可点击（cursor + title 提示）→ 分析中面板 → 分析结果面板（issue 标题 + 分析文本 + 「添加到评论 / 取消」按钮）→ 同意调 comment，显示「✅ 已添加到 Jira 评论」；submitting 禁用按钮，error 显示错误。
**验证**：`pnpm build` 通过、双半区类型检查通过；冒烟测试（真实 Jira 读详情 + mock LLM + mock 评论写入）—— analyze 返回 `{ key, summary, analysis }`、comment POST 到 `/rest/api/3/issue/{key}/comment`（ADF body）全部通过；`node --check` 通过。

## 2026-08-31 — 客户端交互优化（气泡只留最新、待办刷新按钮、ping 1 秒恢复）

**类型**：功能
**涉及**：`src/client/index.tsx`、`README.md`、`CLAUDE.md`、`docs/plugin-dev-handbook.md`
**背景 / 问题**：三处客户端交互需调整 —— 长轮询气泡只应显示最新一条；「我的待办」需要独立刷新入口；hello 按钮 ping 后应短暂显示 pong 再恢复计数。
**改动**：
- 长轮询：`setEvents` 只保留最后一次 poll 返回的最后一个事件（不再累计 5 条气泡）。
- 待办卡片头部右侧新增「⟳」刷新按钮，点击调用 `loadTodos()` 重新拉取列表。
- hello 按钮：点击后显示 `…` → ping 成功显示 pong（或错误）→ 1 秒后恢复 `hello world x{n}` 且计数 +1；用 `clickSeqRef` 序号防竞态（连点时只有最后一次生效）+ `replyTimerRef` 定时器清理（卸载/重按时清）。
**验证**：`pnpm build` 通过、client 类型检查通过。

## 2026-08-31 — 恢复长轮询与 ping（学习项目：只增不删）

**类型**：重构
**涉及**：`src/host/index.ts`、`src/client/index.tsx`、`README.md`、`CLAUDE.md`、`docs/learning-path.md`、`docs/plugin-dev-handbook.md`
**背景 / 问题**：上一轮「待办列表」改动误删了长轮询事件推送；本仓库是学习项目，除非明确要求否则只添加不删除。应恢复长轮询与 ping，与待办列表共存。
**改动**：
- 宿主恢复 `PendingEvent` 类型、`pending` 队列 + `waiters` 挂起表、`emit()` 广播唤醒、`/hello/events/poll` 端点（15s 超时 / abort 清理）、每 5 秒 `hello/notice` 定时推送。
- 客户端恢复 `events` state、长轮询循环（`inflight` await 后复位）、按钮上方事件气泡条。
- 恢复 README / CLAUDE.md 的长轮询章节与验证步骤、learning-path 第 5 章原文、handbook 验证清单长轮询项。
**验证**：`pnpm build` + `node --check` 通过；冒烟测试 —— ping / jira/todos（真实 Jira 返回 1 条）/ events/poll（挂起 5s 后被 `hello/notice` 唤醒）三端点全部正常。

## 2026-08-31 — Jira 待办列表（替代类别条，移除长轮询）

**类型**：功能 + 重构
**涉及**：`src/host/index.ts`、`src/client/index.tsx`、`README.md`、`CLAUDE.md`、`docs/`
**背景 / 问题**：此前展示的是「Issue Type 类别条」；需求改为只展示待办事项列表，类型以徽章内嵌在列表中。
**改动**：
- 宿主移除 `/hello/issue-types` 端点与长轮询事件队列（`pending`/`waiters`/`emit`/`events/poll`），新增 `/hello/jira/todos`：调 `GET {baseUrl}/rest/api/3/search/jql`（Basic Auth、10s 超时），JQL `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`，映射为 `{ key, summary, typeName, typeColor, typeIconUrl, statusName }`。
- 客户端改为「我的待办」悬浮卡片：挂载自动加载，每项含类型徽章（图标或代表色圆点 + 类型名）+ 摘要 + `KEY · 状态`；移除事件气泡与长轮询循环；保留底部 ping 按钮（点击同时刷新待办）。
- 中文 Issue Type 名加入颜色映射（故事/任务/缺陷/史诗/改进/子任务）。
**验证**：`pnpm build` 通过；真实 Jira 实测 —— 初次调 `/rest/api/2/search` 返回 410，改 `/rest/api/3/search/jql` 后返回待办 `JYSXS-115`（类型「故事」→ `#16825d`）；无配置时返回 `jira-not-configured`。

## 2026-08-31 — Jira 配置支持放工程内（jira.config.json 优先）

**类型**：功能
**涉及**：`src/host/index.ts`、`jira.config.json`（新增，gitignore）、`jira.config.example.json`（新增）、`.gitignore`、`README.md`、`CLAUDE.md`、`docs/dev-log.md`
**背景 / 问题**：Jira 凭据此前只能放全局 `$DSH_HOME/settings.yaml`，开发时改全局配置不方便；希望配置能随工程走。
**改动**：
- host 新增 `loadProjectJiraConfig()`：从 bundle 所在目录（`lib/`）逐级向上找 `jira.config.json`，命中即读取（`baseUrl`/`email`/`apiToken`）。
- 优先级：**工程 `jira.config.json` > `ctx.settings`**；端点改用 `resolveJiraSettings()` 动态解析。
- 工程根放 `jira.config.example.json`（占位符，可提交）；真实凭据 `jira.config.json` 加入 `.gitignore`。
**验证**：`pnpm build` 通过；冒烟测试 —— 工程根有配置文件时加载成功且返回真实 Jira 数据（无 settings 服务也工作）；无配置文件时回退 settings，未配置返回 `jira-not-configured`。

## 2026-08-31 — 宿主半区迁移为 TypeScript 并新增读取 Jira Issue Type

**类型**：功能 + 重构
**涉及**：`src/host/index.ts`（新增）、`tsconfig.host.json`（新增）、`tsdown.config.ts`、`package.json`、`dev.patch.yml`、`src/client/index.tsx`、`README.md`、`CLAUDE.md`、`docs/plugin-dev-handbook.md`、`docs/learning-path.md`
**背景 / 问题**：宿主半区仍是手写 `host.js`（无类型检查）；需要为插件增加读取 Jira 类别（Issue Type）的能力 —— host 侧调 Jira API 读取、client 侧展示。
**改动**：
- **宿主 TS 化**：`host.js` 迁为 `src/host/index.ts`；新增 `tsconfig.host.json`（node 类型）；`tsdown.config.ts` 改为数组配置（host → node ESM 单文件 `lib/host.js`，schemastery 内联、其余依赖 type-only 擦除；client 维持 ModuleLoader 工厂）；`package.json` `exports["."]` 指向 `lib/host.js`；`dev.patch.yml` 指向 `lib/host.js`。
- **Jira 读取**：宿主经 `ctx.settings` 注册 `jira` namespace（`baseUrl`/`email`/`apiToken`，settings 服务非必需、拿不到照常加载）；新增 `/hello/jira/issue-types` 端点调 `GET {baseUrl}/rest/api/2/issuetype`（Basic Auth、10 秒超时），映射为 `{ id, name, color, iconUrl }`（颜色按名称匹配常见类型，其余确定性 hash 取色；相对图标路径拼 baseUrl）；未配置返回 `jira-not-configured`，失败返回 `jira-error`。
- **客户端展示**：点击 `HelloPill` 同时拉取 issue types，类别条渲染在按钮上方（图标或代表色圆点 + 名称）；失败显示红色错误条。
**验证**：`pnpm build` 通过；`node --check lib/host.js lib/client.js` 通过；冒烟测试 mock ctx —— 未配置时返回 `jira-not-configured`、ping/未知端点正常；mock settings + mock fetch —— Basic Auth 头、颜色映射、相对图标拼接全部断言通过。

## 2026-08-31 — 支持本机 Chrome 调试远端客户端 TSX

**类型**：功能
**涉及**：`tsconfig.client.json`、`tsdown.config.ts`、`README.md`
**背景 / 问题**：在 Remote-SSH 中 DSH 服务运行于远端、Chrome 运行于本机；最终 bundle 的 source map 原本只映射到中间 JS，无法在本机 Chrome DevTools 命中 `src/client/index.tsx`。
**改动**：启用 TypeScript source map，并让 tsdown 直接从 TSX 源码打包，使最终 bundle 映射到 `src/client/index.tsx`；README 记录通过 VS Code 端口转发后使用本机 Chrome DevTools 的调试流程。
**验证**：`pnpm build` 通过；`lib/client.js.map` 的 sources 包含 `../src/client/index.tsx`。

## 2026-08-31 — 增加 DeepSeek Harness Web 调试启动项

**类型**：功能
**涉及**：`.vscode/launch.json`、`README.md`
**背景 / 问题**：调试插件时需要手动切换到 `deepseek-harness` 工作目录并输入带本地 patch 的 dsh Web 启动命令。
**改动**：新增 `DSH Web（hello-plugin patch）` 启动配置；以 `/home/gehc/work/dsh/deepseek-harness` 为工作目录运行 `pnpm dsh web --patch ../hello-plugin/dev.patch.yml`，并自动附加子进程调试器。
**验证**：VS Code 对 `.vscode/launch.json` 的配置诊断通过。

## 2026-08-31 — 客户端迁移为 TypeScript 并提供浏览器构建

**类型**：重构
**涉及**：删除 `client.js`、`src/client/index.tsx`、`tsconfig.client.json`、`tsdown.config.ts`、`package.json`、`.gitignore`、`README.md`、`CLAUDE.md`
**背景 / 问题**：客户端代码以手写经典脚本维护，缺少静态类型检查和可重复的浏览器 bundle 构建入口。
**改动**：将 `HelloPill`、RPC 与长轮询逻辑迁移为严格 TypeScript；新增 `tsc` + `tsdown` 两阶段构建，产物为保留 ModuleLoader 协议的 `lib/client.js`；包导出改为指向构建产物。
**验证**：`pnpm build`。
>
> **更新开发日志时，同时将一条简述更新到 `README.md` 的「开发日志」章节**（最新在上，一句话概括标题与要点，指向本文件）。
>
> 记录格式（简版即可，保留关键信息）：
> ```markdown
> ## YYYY-MM-DD — 标题
>
> **类型**：功能 / BUG 修复 / 文档 / 重构
> **涉及**：文件清单
> **背景 / 问题**：一句话说明为什么
> **改动**：关键点
> **验证**：如何确认生效（node --check / 实测 / 脚本断言）
> ```

---

## 2026-08-28 — 整理学习路径并按章节由简入深，移除 HTML 手册

**类型**：文档
**涉及**：`docs/learning-path.md`（新增）、删除 `docs/dsh-plugin-handbook.html`、`docs/plugin-capability-catalog.html`、`CLAUDE.md`
**背景 / 问题**：学习材料散落且无顺序；HTML 手册冗余（与 Markdown 重复），决定全部用 Markdown。
**改动**：
- 新增 `docs/learning-path.md`：按 4 阶段 11 章组织学习路径（打地基 / 双向通信 / 能力全景 / 工程纪律），每章含「学什么 / 读什么 / 动手做 / 产出」，并链接现有 Markdown 文档。
- 删除两份 HTML 手册（`dsh-plugin-handbook.html`、`plugin-capability-catalog.html`），docs 全部为 Markdown。
- CLAUDE.md 仓库布局同步更新。
**验证**：docs 目录仅剩 `.md` 文件；grep 确认无残留 HTML 引用（历史 dev-log 条目除外，已一并清理）。

## 2026-08-28 — README 增加开发日志简述章节

**类型**：文档
**涉及**：`README.md`、`CLAUDE.md`、`docs/dev-log.md`
**背景 / 问题**：开发日志集中在 `docs/dev-log.md`，但 README 是仓库入口，读者需要能在 README 里快速看到最近改了什么。
**改动**：README 新增「开发日志」章节（最新在上，一句话简述 + 指向完整日志）；CLAUDE.md 与 dev-log.md 的规则补充「更新开发日志时，同时将简述更新到 README」。
**验证**：README「开发日志」章节显示全部历史简述，与 dev-log.md 对应。

## 2026-08-28 — 修复客户端长轮询循环只跑一轮的 bug

**类型**：BUG 修复
**涉及**：`client.js`
**背景 / 问题**：客户端 `events/poll` 长轮询只拉取一次就停止，之后不再更新宿主推送的消息。根因：`poll()` 内 `inflight` 置 `true` 后**从未复位**，第二轮 `poll()` 被 `if (cancelled || inflight) return` 挡死，循环终止。用独立脚本复现确认（10ms 内只执行 1 次）。
**改动**：在 `await connection.rpc.call(...)` 结束后（含 try 成功与 catch 两条路径）都加 `inflight = false`，使循环能持续拉取；失败路径保持 3 秒退避。
**验证**：`node --check client.js` 通过；复现脚本显示修复后循环持续执行。

## 2026-08-28 — hello/notice 示例事件改为每 5 秒推送

**类型**：功能
**涉及**：`host.js`、`README.md`、`docs/plugin-dev-handbook.md`
**背景 / 问题**：原实现「启动 5 秒后自动发一次事件」，无法持续演示「host 主动推送 → client 持续更新」。
**改动**：`host.js` 用 `setInterval` 替代一次性 `setTimeout`，每 5 秒 emit 一次 `hello/notice`（带当前时间戳）；同步更新 README 与手册的验证描述。
**验证**：`node --check` 通过；文档描述同步为「每 5 秒出现新的气泡条」。

## 2026-08-28 — 新增 dsh 插件能力清单（学习文档）

**类型**：文档
**涉及**：`docs/plugin-capability-catalog.md`、`cordis.patch.yml`
**背景 / 问题**：需要一份 dsh 对 plugin 开放的所有能力面的清单，供后续学习。
**改动**：基于 harness 源码与 `capability-seams.md` 权威目录整理：Cordis 内核、宿主端服务 6 类 52 项、客户端服务、双向通信通道 6 种、插槽体系、工具贡献、关键约束、源码地图。同时把 `cordis.patch.yml` 的宿主插件 `name` 改为可移植包名。
**验证**：Markdown 表格结构检查通过。

## 2026-08-28 — 宿主主动推送事件到客户端（长轮询）

**类型**：功能
**涉及**：`host.js`、`client.js`、`README.md`、`docs/plugin-dev-handbook.md`
**背景 / 问题**：第二步开发 —— 让 host 主动触发事件、client 收到。调研发现 dsh 标准事件转发（`ctx.remote.$on`）对自定义事件不适用：`registerRemoteEvents` 是单例（api-remotes 占用），事件名须进 allowlist。
**改动**：
- 宿主维护 `pending` 队列 + `waiters` 挂起表，`emit(event, args)` 广播唤醒所有 waiter；`/hello/events/poll` 端点挂起等待（15 秒超时 / abort 清理）。
- 客户端挂载后跑长轮询循环，事件渲染为按钮上方气泡条。
- 并发审查：waiter 从单槽改数组；广播改为先 splice 快照再分发，避免第一个 waiter 拿光。
**验证**：长轮询核心逻辑独立脚本验证 5 场景 10 断言全过。

## 2026-08-28 — 客户端点击调用宿主（接通 /hello RPC）

**类型**：功能
**涉及**：`host.js`、`client.js`、`README.md`、`docs/plugin-dev-handbook.md`、`.gitignore`
**背景 / 问题**：第一步开发 —— client 点击调用 host。
**改动**：
- 宿主 `inject: ['connection']`，`ctx.connection.rpc.handle('/hello', handler)` 注册通道。
- 客户端 `HelloPill` 点击时 `connection.rpc.call('/hello', 'ping', { args })`。
- 修复：`HelloPill` 从模块级组件引用 `ctx` 报 `ReferenceError: ctx is not defined` → 改为通过 `slots.register` 的 `inject` 业务面把 `connection` 传成组件 prop；组件直接传（非 `() => createElement(...)`）。
**验证**：`node --check` 通过；注册 id 与包名一致。

## 2026-08-28 — 修正插件 ID 与包名一致

**类型**：BUG 修复
**涉及**：`client.js`
**背景 / 问题**：`load({ id })` 注册的 id 与包名不一致，模块系统以包名为图行 id，factory-presence 校验会拒绝产物。
**改动**：注册 id 统一为 `dsh-hello-plugin`。
**验证**：`node --check` 通过。

## 2026-08-28 — 添加 dsh-hello-plugin 插件初始代码

**类型**：实现
**涉及**：`host.js`、`client.js`、`cordis.patch.yml`、`package.json`、`README.md`
**背景 / 问题**：仓库初始化 —— 最小可运行的双面插件骨架。
**改动**：宿主半区打日志；客户端半区渲染悬浮按钮并注入 `shell.overlay` 插槽；patch 层插入宿主插件行。
**验证**：`node --check` 通过。
