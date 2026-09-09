# hello-plugin dsh 能力全景

> 按 [plugin-capability-catalog.md](plugin-capability-catalog.md) 的类别体系梳理 hello-plugin 已使用及未使用的 dsh（DeepSeek Harness）能力。每个能力标注「已使用 ✅ / 未使用 ⬜」，已使用的附源码位置和使用场景，未使用的附潜在用途。

---

## 一、Cordis 内核

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.logger()` | ✅ | `src/host/index.ts` | 宿主日志输出（`logger.info('host loaded')`） |
| `ctx.effect()` | ✅ | `src/host/index.ts` | 副作用注册（定时器，卸载自动回收） |
| `ctx.get()` | ✅ | 多处 | 获取 settings / agents / workspaceRegistry 等服务 |
| `ctx.on()` | ⬜ | — | 未使用 |
| `ctx.emit()` | ⬜ | — | 未使用（长轮询用自定义 emit，不走 Cordis 标准事件） |
| `ctx.parallel` / `ctx.waterfall` | ⬜ | — | 未使用 |
| `ctx.plugin()` | ⬜ | — | 未使用 |
| `ctx.provide()` | ⬜ | — | 未使用 |

---

## 二、宿主端核心服务

### 2.1 Agent 与会话

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.agents` | ✅ | `src/host/index.ts`、`src/host/jira-agent.ts` | `agents.create()` 创建新闻总结 / Jira 分析 Agent 会话；后者 `followup` 发任务后 `agent.whenIdle()` 等静止，从 `session.events` 折叠最终文本回传 |
| `ctx.sessionTitle` | ✅ | `src/host/index.ts`、`src/host/jira-agent.ts` | `sessionTitle.rename()` 命名会话标题（「获取新闻 <时间>」/「分析 KEY <时间>」） |
| `ctx.agentLoop` | ⬜ | — | 未使用 |
| `ctx.sessions` | ⬜ | — | 未使用 |
| `ctx.sessionPersistence` | ⬜ | — | 未使用 |
| `ctx.sessionQuery` | ⬜ | — | 未使用 |
| `ctx.sessionProjections` | ⬜ | — | 未使用 |
| `ctx.sessionTelemetry` | ⬜ | — | 未使用 |
| `ctx.subagents` | ⬜ | — | 未使用 |
| `ctx.agentTeams` | ⬜ | — | 未使用 |
| `ctx.agentDefaultModel` | ⬜ | — | 未使用 |
| `ctx.goals` | ⬜ | — | 未使用 |
| `ctx.jobs` | ⬜ | — | 未使用 |

### 2.2 模型与工具

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.llm` | ⬜ | — | 未使用（原 Jira 分析用例已迁至 Agent 会话，不再直连 `ctx.llm.stream`；Agent 的模型经 `llm.config.json` 配置） |
| `ctx.tools` | ✅ | `src/host/news.ts`、`src/host/jira-tools.ts` | `ctx.tools.register()` 注册全局工具：google_news（ScopedLayers）、jira_search_issues、jira_get_issue、jira_create_issue、jira_add_comment、jira_update_status、jira_get_transitions |
| `ctx.systemPrompt` | ⬜ | — | 未使用 |
| `ctx.tokenMeter` | ⬜ | — | 未使用 |
| `ctx.deepseekLlmApiExtensions` | ⬜ | — | 未使用 |
| `ctx.toolResultPruner` | ⬜ | — | 未使用 |

### 2.3 文件与执行（全部未使用）

| 能力 | 状态 | 潜在用途 |
| --- | --- | --- |
| `ctx.fs` | ⬜ | 读取/写入本地文件（如缓存 Jira 数据） |
| `ctx.shell` | ⬜ | 执行 shell 命令 |
| `ctx.shellEnv` | ⬜ | 管理命令环境变量 |
| `ctx.terminals` | ⬜ | PTY 终端管理 |
| `ctx.subprocess` | ⬜ | 子进程管理 |
| `ctx.codeRuntime` | ⬜ | 代码执行运行时 |
| `ctx.sandbox` | ⬜ | 沙箱执行 |
| `ctx.sandboxPolicy` | ⬜ | 沙箱策略配置 |
| `ctx.lsp` | ⬜ | 语言服务器协议 |
| `ctx.e2b` | ⬜ | E2B 云沙箱 |
| `ctx.web` | ⬜ | 网页抓取/搜索 |

### 2.4 用户交互（全部未使用）

| 能力 | 状态 | 潜在用途 |
| --- | --- | --- |
| `ctx.commands` | ⬜ | 注册命令面板命令（如「刷新待办」） |
| `ctx.userQuestions` | ⬜ | 向用户弹窗提问 |
| `ctx.approval` | ⬜ | 审批流 |
| `ctx.permissionPresets` | ⬜ | 权限预设 |
| `ctx.authorization` | ⬜ | 授权流注册 |

### 2.5 配置与数据

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.settings` | ✅ | `src/host/index.ts` | 注册 jira namespace、读取 settings.yaml 配置 |
| `ctx.workspaceRegistry` | ✅ | `src/host/index.ts`、`src/host/jira-agent.ts` | `create(path, title)` / `attachSession()`：新闻会话归「新闻头条」（宿主 cwd），Jira 分析会话归「Jira 分析」（插件包根目录，独立分组） |
| `ctx.credentials` | ⬜ | — | 未使用（jira 凭据走工程文件 jira.config.json） |
| `ctx.storage` | ⬜ | — | 未使用 |
| `ctx.storageDomain` | ⬜ | — | 未使用 |
| `ctx.attachments` | ⬜ | — | 未使用 |
| `ctx.messageFeedback` | ⬜ | — | 未使用 |
| `ctx.spillStore` | ⬜ | — | 未使用 |

### 2.6 插件系统自省（全部未使用）

| 能力 | 状态 | 潜在用途 |
| --- | --- | --- |
| `ctx.typert` | ⬜ | 运行时类型注册表 |
| `ctx.typertGateway` | ⬜ | Typert Host 调用网关 |
| `ctx.dynamicCordisRunner` | ⬜ | 动态包加载 |
| `ctx.cordisInspect` | ⬜ | Cordis 运行时自省 |
| `ctx.pluginInventory` | ⬜ | 插件清单 |
| `ctx.invariants` | ⬜ | 包级不变式注册 |
| `ctx.compaction` | ⬜ | 上下文压缩 |
| `ctx.workflowEngine` | ⬜ | 工作流引擎 |
| `ctx.skills` | ⬜ | 技能注册表 |
| `ctx.agentPresets` | ⬜ | Agent 预设 |
| `ctx.planMode` | ⬜ | 计划模式 |
| `ctx.timer` | ⬜ | 定时器 |
| `ctx.schedule` | ⬜ | 定时任务工具 |

---

## 三、客户端核心服务

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.connection` | ✅ | `src/client/index.ts` | `rpc.call()` 调宿主 RPC |
| `ctx.slots` | ✅ | `src/client/index.ts` | `inject()` + `register()` 注册 HelloPill 到 shell.overlay |
| `ctx.remote` | ⬜ | — | 未使用（走 connection.rpc 而非 typert remote） |
| `ctx.layout` | ⬜ | — | 未使用 |
| `ctx.theme` | ⬜ | — | 未使用 |
| `ctx.locale` | ⬜ | — | 未使用 |
| `ctx.settingsScope` | ⬜ | — | 未使用 |
| `ctx.settingsSchema` | ⬜ | — | 未使用 |
| `ctx.uiSession` | ⬜ | — | 未使用 |
| `ctx.uiConversation` | ⬜ | — | 未使用 |
| `ctx.uiWorkspace` | ⬜ | — | 未使用 |
| `ctx.commandUi` | ⬜ | — | 未使用 |
| `ctx.modelDirectories` | ⬜ | — | 未使用 |
| `ctx.inputTriggers` | ⬜ | — | 未使用 |
| `ctx.clientModules` | ⬜ | — | 未使用 |
| `ctx.timer` | ⬜ | — | 未使用 |

---

## 四、双向通信

| 通道 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| **Unary RPC** | ✅ | `src/host/index.ts` + `src/client/` | 客户端 → 宿主：ping / jira/todos / jira/analyze（发起即返回 `{ sessionId }`）/ jira/comment / news/start |
| **长轮询** | ✅ | `src/host/index.ts` | 宿主 → 客户端：`events/poll` 广播推送，15s 超时；既推 `hello/notice` 气泡，也推 `jira/analysis-done` / `jira/analysis-failed` 结构化载荷 |
| **Typert Remote** | ⬜ | — | 未使用 |
| **Remote events** | ⬜ | — | 未使用（allowlist 限制，改用长轮询） |
| **WebSocket mux** | ⬜ | — | 未使用 |
| **Fetch 精确路由** | ⬜ | — | 未使用 |

---

## 五、插槽与 UI

| 槽位 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `shell.overlay` | ✅ | `src/client/index.ts` | HelloPill 悬浮组件（list 槽，叠加式） |
| `root` | ⬜ | — | 未使用（single 槽，会 shadow 整个 frame） |

---

## 六、工具贡献

| 能力 | 状态 | 源码位置 | 使用场景 |
| --- | --- | --- | --- |
| `ctx.tools.register()` | ✅ | `src/host/news.ts` | 注册 `google_news` 工具到 Agent 作用域（ScopedLayers） |
| `ctx.tools.schemas()` | ⬜ | — | 未使用 |
