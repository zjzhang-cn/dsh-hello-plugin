# dsh 插件能力清单（Plugin Capability Catalog）

> 面向 dsh（DeepSeek Harness）插件开发者的能力地图。dsh 是一个全插件化 Cordis agent 框架 —— 插件本质是 Cordis 插件，因此「dsh 对 plugin 开放的能力」= **Cordis 内核能力 + dsh 提供的 `ctx.*` 服务 + 双向通信通道 + 插槽/UI 体系**。
>
> 本文所有 `ctx.*` 服务均可通过插件的 `inject: ['服务名']` 声明依赖后，在 `apply(ctx)` 里以 `ctx.服务名` 访问。源码位置均为 deepseek-harness 内相对路径。

## 一、Cordis 内核能力（所有插件的基础）

任何插件（宿主/客户端）都有的 Cordis 上下文 API。详见 `vendor/cordis` 与 `docs/cordis-primer.md`。

| 能力 | 用法 | 说明 |
| --- | --- | --- |
| 插件导出 | `export const name` + `export function apply(ctx)` | 宿主半区标准形态 |
| 服务注入 | `inject: ['svc']` 或 `return { inject: ['svc'], apply }` | 声明依赖，激活后 `ctx.svc` 可用 |
| 生命周期 | `ctx.effect(callback, label)` | 副作用放进 effect，卸载自动回收 |
| 事件监听 | `ctx.on(event, listener)` | 监听 Cordis 事件 |
| 事件广播 | `ctx.emit(event, ...args)` | 触发事件（宿主端） |
| 事件流水线 | `ctx.parallel(...)` / `ctx.waterfall(...)` | 并行/串行分发模式 |
| 子插件 | `ctx.plugin(Plugin, config)` | 在插件内再挂子插件 |
| 服务提供 | `ctx.provide(name, value)` | 向依赖方暴露自有服务 |
| 服务获取 | `ctx.get(name)` / `ctx.inject([...], cb)` | 读取/注入服务 |
| 日志 | `ctx.logger('scope')` | 带 scope 的日志器 |

## 二、宿主端核心服务（Node 进程内）

### 2.1 Agent 与会话

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.agents` | core/agent | Agent 注册表与生命周期 |
| `ctx.agentLoop` | core/agent-loop | Agent 主循环（模型调用循环） |
| `ctx.sessions` | core/session | 内存会话存储 |
| `ctx.sessionPersistence` | session/session-persistence | 会话持久化 seam（jsonl/sqlite 实现） |
| `ctx.sessionQuery` | session-query | 会话事件查询 |
| `ctx.sessionProjections` | session/session-projection | 会话投影 |
| `ctx.sessionTitle` | session/session-title | 会话标题生成 |
| `ctx.sessionTelemetry` | session/session-telemetry | 会话遥测 seam |
| `ctx.subagents` | subagent/subagent | 子 Agent 管理 |
| `ctx.agentTeams` | experimental/agent-team | Agent 团队（实验） |
| `ctx.agentDefaultModel` | core/agent-default-model | Agent 默认模型选择 |
| `ctx.goals` | goal/goal | 目标管理 |
| `ctx.jobs` | jobs/jobs | 后台任务运行时（bash、PTY、subagent 统一） |

### 2.2 模型与工具

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.llm` | llm/llm | LLM 适配器注册表 |
| `ctx.tools` | core/tools | 工具注册表（`register` / `schemas()` / `get`）—— 插件贡献模型可见工具 |
| `ctx.systemPrompt` | core/system-prompt | 系统提示词组装（`section()`） |
| `ctx.tokenMeter` | llm/token-meter | Token 计量 |
| `ctx.deepseekLlmApiExtensions` | llm/deepseek-llm-api-extensions | DeepSeek 官方请求扩展 |
| `ctx.toolResultPruner` | compaction/tool-result-pruner | 工具结果裁剪 |

### 2.3 文件与执行

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.fs` | fs/fs | 文件系统 seam（`processPathFromHostPath` 等） |
| `ctx.shell` | shell/shell | 命令执行 seam（bash/pwsh） |
| `ctx.shellEnv` | shell/shell-env | 命令环境变量 |
| `ctx.terminals` | terminal/terminal | PTY 终端管理 |
| `ctx.subprocess` | subprocess/subprocess | 子进程管理 |
| `ctx.codeRuntime` | code-runtime | 代码执行运行时 |
| `ctx.sandbox` | sandbox/sandbox | 沙箱执行 |
| `ctx.sandboxPolicy` | sandbox/sandbox-policy | 沙箱策略 |
| `ctx.lsp` | lsp/lsp | 语言服务器协议 |
| `ctx.e2b` | e2b/e2b | E2B 云沙箱 |
| `ctx.web` | web/web | Web 抓取（`registerSearchProvider` / `registerFetchProvider`） |

### 2.4 用户交互

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.commands` | interaction/commands | 命令注册 |
| `ctx.userQuestions` | interaction/user-questions | 向用户提问 |
| `ctx.approval` | interaction/user-approval | 审批流 |
| `ctx.permissionPresets` | interaction/permission-presets | 权限预设 |
| `ctx.authorization` | credentials/authorization | 授权流注册 |
| `ctx.userQuestions` | interaction/user-questions | 用户提问 |

### 2.5 配置与数据

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.settings` | settings/settings | 用户设置 seam |
| `ctx.credentials` | credentials/credentials | 凭据 seam |
| `ctx.storage` | storage/storage | 非会话存储枢纽 |
| `ctx.storageDomain` | storage/storage-domain | 领域数据设施 |
| `ctx.attachments` | attachment/attachment | 持久化二进制附件 |
| `ctx.messageFeedback` | feedback/message-feedback | 消息反馈 |
| `ctx.workspaceRegistry` | workspace/workspace | 工作区注册 |
| `ctx.spillStore` | spill/spill | 溢出结果存储 |
| `ctx.settingsScope`（客户端） | client/ui-settings | 设置作用域绑定 |

### 2.6 插件系统自省

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.typert` | typert/registry | 运行时类型注册表（生成式 Remote 反射） |
| `ctx.typertGateway` | api/gateway | Typert Host 调用网关 |
| `ctx.dynamicCordisRunner` | extensions/cordis-host-runner | 动态包加载（vm 沙箱） |
| `ctx.cordisInspect` | extensions/cordis-host-runner | Cordis 运行时自省 |
| `ctx.pluginInventory` | host/plugin-inventory | 插件清单 |
| `ctx.invariants` | runtime-diagnostics/invariants | 包级不变式注册 |
| `ctx.compaction` | compaction/compaction | 上下文压缩 |
| `ctx.workflowEngine` | workflow/workflow | 工作流引擎 |
| `ctx.skills` | skill/skill | 技能（Skill）注册表 |
| `ctx.agentPresets` | preset/agent-presets | Agent 预设 |
| `ctx.planMode` | plan/plan-mode | 计划模式 |
| `ctx.timer`（客户端） | extensions/cordis-client-runner | 定时器 |
| `ctx.schedule` | schedule（工具包） | 定时任务工具 |

## 三、客户端核心服务（浏览器内）

客户端插件运行在浏览器，`apply(ctx)` 在客户端 Cordis 容器里。除 Cordis 内核外，还提供：

| 服务 | 提供包 | 说明 |
| --- | --- | --- |
| `ctx.remote` | api/gateway client | **Typert 生成式 Remote**：`ctx.remote.<namespace>.<method>()` 调用宿主；`ctx.remote.$on(event)` 收宿主转发事件；`ctx.remote.$stream` 流式；`ctx.remote.$mount` 装载贡献 |
| `ctx.connection` | client/connection | **浏览器↔宿主线缆**：`rpc.call(channel, endpoint, { args })` 调宿主；宿主端同名服务提供 `rpc.handle` |
| `ctx.slots` | client/ui-renderer | **插槽系统**：`register({ name, id, inject }, Component)` 注入组件 |
| `ctx.layout` | client/ui-layout | 布局：`toggleSidebar` / `openDetails` / `closeDetails` / `attachPanels` |
| `ctx.theme` | client/ui-theme | 主题 |
| `ctx.locale` | client/locale | 国际化/翻译 |
| `ctx.settingsScope` | client/ui-settings | 设置作用域绑定 |
| `ctx.settingsSchema` | client/ui-settings | 设置 schema |
| `ctx.uiSession` | client/ui-session | 客户端会话面 |
| `ctx.uiConversation` | client/ui-conversation | 对话面 |
| `ctx.uiWorkspace` | client/ui-workspace | 工作区导航 |
| `ctx.commandUi` | client/ui-commands | 命令 UI |
| `ctx.modelDirectories` | client/ui-model-selection | 模型目录 |
| `ctx.inputTriggers` | client/ui-input-trigger | 输入触发 |
| `ctx.clientModules` | client/modules | 客户端模块系统 |
| `ctx.timer` | extensions/cordis-client-runner | 客户端定时器 |

## 四、双向通信通道

这是 dsh 双面插件的核心。宿主与客户端之间隔着 HTTP + WebSocket，消息必须走封装通道。

| 通道 | 方向 | 机制 | 关键 API |
| --- | --- | --- | --- |
| **Unary RPC** | 客户端 → 宿主 | POST `/api/<endpoint>`，payload `{ args }` | 客户端 `ctx.connection.rpc.call('/hello','ping',{args})`；宿主 `ctx.connection.rpc.handle('/hello', handler)` |
| **Typert Remote** | 客户端 → 宿主 | 生成式 descriptor，`namespace/method` 端点 | 客户端 `ctx.remote.<ns>.<method>()`；宿主用 `@typert` 标记 Service 方法 |
| **Remote events** | 宿主 → 客户端 | `ctx.emit` → api-remotes 转发 → 网关广播 → 客户端 `$on` | 客户端 `ctx.remote.$on(event, listener)`；宿主 `ctx.emit(event)`；**注意**：事件名必须在 `API_REMOTE_FORWARDED_EVENTS` allowlist，`registerRemoteEvents` 是单例 |
| **长轮询** | 宿主 → 客户端 | 复用 `rpc.handle` 通道挂起等待 | 宿主 `events/poll` 端点 + 客户端循环（见 hello-plugin 实现） |
| **WebSocket mux** | 双向 | `/api/remote.mux`，Typert stream | `ctx.remote.$stream`；`connection.rpc.open`（仅 worker 隧道） |
| **Fetch 精确路由** | 宿主 → 客户端 | `connection.rpc.fetch.register` 注册 GET/HEAD 路由 | 宿主提供浏览器原生响应 |

## 五、插槽（Slots）与 UI 体系

客户端 UI 通过插槽组合，`shell.overlay` 等是预声明槽。

| 槽位 | 类型 | 用途 |
| --- | --- | --- |
| `root` | single | 渲染树根（**不要注册**，会 shadow 掉整个 frame） |
| `shell.overlay` | list | 悬浮叠加层（叠加式，可多个） |
| 其余由布局声明 | single/keyed/list/chain | 侧栏、对话、详情等 |

**注入组件的正确姿势**（`slots.register` 的 `inject` 业务面）：
```js
function Comp({ connection }) { /* 组件拿服务只靠 props */ }
ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
  { name: 'shell.overlay', id: 'my-widget', inject: () => ({ connection: ctx.connection }) },
  Comp,  // 直接传组件，别包一层
)))
```
要点：组件直接传（非 `() => createElement(...)`）；`inject` 工厂闭包捕获 `apply(ctx)` 的 `ctx`；组件永不引用模块级 `ctx`。

## 六、工具（Tools）贡献

插件通过 `ctx.tools.register(definition)` 贡献模型可见工具。工具定义含 `name` / `description` / JSON-Schema `parameters`，模型经系统提示词组装看到。`ctx.tools.schemas()` 返回当前可用的工具 schema 白名单。

## 七、关键约束（踩过的坑）

1. `/api` 共享通道只允许一个 interceptor（api-gateway 独占）→ 自定义通道另开如 `/hello`。
2. `typertGateway.registerRemoteEvents` 是单例（api-remotes 已占用）→ 自定义事件不走标准转发，用长轮询。
3. 自定义事件名无法进 `API_REMOTE_FORWARDED_EVENTS` allowlist（除非改 harness）。
4. `window.__ModuleLoader__.load({ id })` 的 id 必须等于包名。
5. 自建 `rpc.handle` 通道在浏览器端是请求-响应（`rpc.open` 只存在于 worker 隧道）。
6. 长轮询要点：广播语义、超时兜底、abort 清理。
7. **`connection.rpc.handle` 在当前 harness 版本消费方不可用**：它把通道注册到 **connection 插件自身 ctx** 的 `webServer` 上（`rpc-host.ts` 的 `register()`：`owner.effect(() => owner.webServer.register(route))`，`owner` = 服务构造时传入的 connection 插件 ctx，只 inject 了 `credentials`）→ 消费方声明依赖无法满足，调用抛 `cannot get property "webServer" without inject`；不抛时通道也挂不上（POST → 静态兜底 405）。**可行做法**：自建 web 路由（插件 inject `webServer`，`ctx.webServer.register({ kind:'prefix', path:'/hello', handler })`）+ 复用 `connection.requestRejection` 栅栏 + Connection RPC 信封（本插件 `src/host/web-channel.ts`）。

## 八、源码地图（快速定位）

| 要查 | 看这里 |
| --- | --- |
| 服务全目录（权威） | `docs/capability-seams.md`（生成的 mermaid 图） |
| 工具 schema 全目录 | `docs/tool-catalog.md`（生成的） |
| Cordis 机制 | `docs/cordis-primer.md`、`vendor/cordis` |
| RPC 信封/通道 | `packages/client/connection/src/rpc.ts` |
| 宿主 RPC 注册 | `packages/client/connection/src/rpc-host.ts` |
| 客户端 RPC 调用 | `packages/client/connection/src/client/rpc.ts` |
| Remote events 转发 | `packages/api/remotes/src/remote-events.ts`（allowlist） |
| 网关（/api 独占） | `packages/api/gateway/src/index.ts` |
| 客户端 Remote | `packages/api/gateway/src/client/index.ts` |
| 插槽 | `packages/client/ui-slots` + `ui-renderer/src/client/registry.ts` |
