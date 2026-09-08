# dsh-hello-plugin

面向 dsh（DeepSeek Harness，全插件化 Cordis agent 框架）的最小可运行插件示例。同时演示了插件的两个半区（宿主 + 浏览器客户端）的完整接入方式：宿主端日志、客户端 UI 组件、插槽注入。

## 结构

| 文件 | 说明 |
| --- | --- |
| `src/host/index.ts` | 宿主半区入口：Node 端 Cordis 插件，`apply(ctx)` 注册 `/hello` RPC 通道（ping + Jira 待办/分析/评论 + 新闻会话 + 事件长轮询），整合各功能模块 |
| `src/host/types.ts` | 共享类型：PendingEvent、JiraSettings、LlmConfig、JiraTodo、JiraIssueDetail、GoogleNewsItem、ConfigLoaderLogger |
| `src/host/constants.ts` | 常量：name、inject、POLL_TIMEOUT_MS、ISSUE_TYPE_COLORS、FALLBACK_COLORS |
| `src/host/errors.ts` | 错误类：JiraConfigError、rpcFailure |
| `src/host/config.ts` | 工程配置文件加载：jira.config.json / llm.config.json 逐级查找与解析 |
| `src/host/jira.ts` | Jira API 工具：fetchJiraTodos、fetchJiraIssueDetail、addJiraComment、adfToText |
| `src/host/llm.ts` | LLM 分析：generateLlmAnalysis（BlockAssembler 聚合输出） |
| `src/host/news.ts` | Google News 工具：fetchGoogleNews、installGoogleNewsTool（ScopedLayers 注册） |
| `src/client/index.ts` | 客户端入口：通过 `ctx.slots.inject` 注册 `HelloPill` 到 `shell.overlay` 插槽 |
| `src/client/types.ts` | 共享类型：HelloEvent、JiraTodo、JiraAnalysis |
| `src/client/components/HelloPill.tsx` | 主容器组件：管理状态 + RPC 调用 + 组合子组件 |
| `src/client/components/TodoCard.tsx` | 待办列表卡片：header + 刷新按钮 + 错误条 + TodoItem 列表 |
| `src/client/components/TodoItem.tsx` | 单个待办项：类型徽章 + 摘要 + KEY/状态 |
| `src/client/components/AnalysisPanel.tsx` | LLM 分析面板：loading / error / result + 评论操作 |
| `src/client/components/EventBubbles.tsx` | 事件气泡条 |
| `src/client/components/NewsStatus.tsx` | 新闻会话状态提示条 |
| `src/client/components/NewsButton.tsx` | 获取新闻按钮 |
| `src/client/components/HelloButton.tsx` | hello 按钮 + ping 交互 |
| `lib/host.js` | 由 `pnpm build` 生成的宿主半区 bundle（Node ESM 单文件，schemastery 内联、dsh-llm external） |
| `lib/client.js` | 由 `pnpm build` 生成的客户端浏览器 bundle（classic script），保留 ModuleLoader factory 协议 |
| `cordis.patch.yml` | bundle patch 层：把宿主插件行插入启动图（boot graph）的插件列表 |
| `.vscode/launch.json` | VS Code 调试配置：在 deepseek-harness 中以本地 `dev.patch.yml` 启动 dsh Web |
| `package.json` | 包清单，声明两个半区的导出与 dsh 集成字段 |
| `docs/dev-log.md` | 开发日志：每次功能 / BUG 修改 / 实现的记录（最新在上） |
| `docs/hello-plugin-capabilities.md` | 本插件 dsh 能力全景：已使用 / 未使用清单（逐项标注源码位置与潜在用途） |
| `docs/learning-path.md` | 学习路径：按章节由简入深的学习路线 |

## 使用方法

### 1. 环境准备

- Node.js ≥ 18
- pnpm（包管理器）
- 已安装并配置好的 [deepseek-harness](https://github.com/deepseek-ai/harness) 工作区

### 2. 安装依赖

```sh
cd dsh-hello-plugin
pnpm install
```

### 3. 配置凭据（可选，用于 Jira / LLM 功能）

- **Jira**：复制示例文件为 `jira.config.json`（已 gitignore，不会提交）：
  ```sh
  cp jira.config.example.json jira.config.json
  ```
  编辑 `jira.config.json`，填入你的 Jira 实例地址、邮箱和 API Token：
  ```json
  {
    "baseUrl": "https://your-jira.example",
    "email": "you@example.com",
    "apiToken": "<Jira API Token>"
  }
  ```

- **LLM**：复制示例文件为 `llm.config.json`（已 gitignore）：
  ```sh
  cp llm.config.example.json llm.config.json
  ```
  编辑 `llm.config.json`，选择 provider 和 model（需与 harness 的 LLM 服务兼容）：
  ```json
  {
    "provider": "deepseek-official",
    "model": "deepseek-chat"
  }
  ```

> 不配置 Jira/LLM 时插件仍可正常加载，对应功能会显示 `jira-not-configured` / `llm-not-configured` 提示，不影响其他功能。

### 4. 构建

```sh
pnpm build
```

构建完成后会在 `lib/` 目录下生成两个文件：
- `lib/host.js` — 宿主半区 bundle
- `lib/client.js` — 客户端半区 bundle

验证构建产物：
```sh
node --check lib/host.js lib/client.js
```

### 5. 运行插件

在 `deepseek-harness` 工作区中以本地 dev patch 启动 dsh Web（推荐用 VS Code 的调试配置「DSH Web（hello-plugin patch）」），或手动执行：

```sh
# 在 deepseek-harness 目录下
pnpm dsh web --patch /path/to/dsh-hello-plugin/dev.patch.yml
```

启动后在浏览器中打开 dsh Web UI，即可在右下角看到「我的待办」悬浮卡片。

### 6. 快速验证

| 操作 | 预期结果 |
| --- | --- |
| 点击 **hello** 按钮 | 按钮短暂显示 `pong from host, hello browser!`，1 秒后恢复 `hello world x{n}`（计数 +1）；宿主日志出现 `client ping: browser` |
| 等待 5 秒 | 按钮上方出现气泡条 `hello/notice: host is alive at ...`（长轮询推送） |
| 点击 **⟳ 刷新** | 重新拉取 Jira 待办列表（如已配置 Jira） |
| 点击某个待办项 | 弹出 LLM 分析面板（如已配置 LLM） |
| 点击 **📰 获取新闻** | 创建新会话，dsh Web UI 会话列表出现该会话，Agent 自动获取并总结 Google 新闻 |

## 架构：双面插件如何接入 dsh

dsh 采用「双面（dual-face）」插件模型：同一个包同时提供 Node 宿主半区与浏览器客户端半区，两侧由同一份 vendored Cordis Loader 治理，插件加载模型详见 deepseek-harness 中的 `2026-07-23-client-plugin-loading-model.md`。

- **宿主半区**：`exports["."]` → `lib/host.js`。它作为普通 Cordis 插件行进入启动图，`apply(ctx)` 在 Node 进程里运行。源码 `src/host/index.ts` 经 `pnpm build` 编译为单文件 Node ESM（schemastery 内联；`@deepseek-ai/dsh-llm` external，运行时从 node_modules 解析——它的内部用 `createRequire` 读自身 package.json，内联会路径错位）。
- **客户端半区**：`exports["./client"]` → `lib/client.js`，由 `dsh.client.platform = "web"` 声明。`dsh-client-modules` 扫描该声明（读取 entry 最近处的 package.json，要求 `dsh.client.platform=web` 且存在 `exports["./client"]`）把插件纳入启动图；浏览器端 bundle 通过 `window.__ModuleLoader__.load({ id, factory })` 注册工厂。注册是**惰性**的：脚本到达只登记 factory，首次 `require` 时才真正执行模块体。
- **patch 层**：`dsh.bundle.patch` → `cordis.patch.yml`。profile 合成器按 `dsh.profile.bundles` 顺序把每个 bundle 的 patch 应用到启动图（空 entry 列表之上），再叠加 profile 自身 patch 与启动器层。

客户端组件走标准 Cordis 插槽机制：`inject: ['slots']` 声明依赖 slots 服务，`apply(ctx)` 里用 `ctx.effect(() => slots.inject('shell.overlay', () => slots.register({ name, id }, ...)))` 把 `HelloPill` 挂到 shell 悬浮层。所有注册都放在 `ctx.effect()` 内，保证卸载时自动回收。

## 客户端调用宿主

`dsh` 的双面插件天然支持「浏览器客户端 → Node 宿主」的 RPC 调用，走的是 client-connection 的通用通道：

- **宿主端**：`src/host/index.ts` 的 `apply(ctx)` 里 `inject: ['connection']`，用 `ctx.connection.rpc.handle('/hello', handler)` 注册一条自定义通道（不能拦截 `/api` —— 那是 api-gateway 独占的共享通道）。handler 收到 `(endpoint, payload)`，返回 `{ ok: true, value }` 或 `{ ok: false, error }`。
- **客户端**：`src/client/index.tsx` 的插件声明 `inject: ['connection']`，点击 `HelloPill` 时用 `ctx.connection.rpc.call('/hello', 'ping', { args: { name } })` 发起调用。payload 遵循 Connection RPC 信封：必须是 `{ args: {...} }`。按钮文本会显示宿主返回的 `pong from host` 消息，**1 秒后恢复 `hello world x{n}` 样式并计数 +1**。

宿主机日志里会输出 `client ping: ...`，可用于确认双向链路打通。

## Jira 待办列表

宿主半区通过以下顺序解析 Jira 连接配置（**工程内 `jira.config.json` 优先，其次 `ctx.settings`**），再调用 Jira REST API 查询指派给当前用户的未解决问题，客户端以「我的待办」列表展示：

- **工程配置文件**（开发时用，已 gitignore 不提交凭据）：工程根放 `jira.config.json`，host 启动时从 bundle 所在目录向上逐级查找：
  ```json
  {
    "baseUrl": "https://your-jira.example",
    "email": "you@example.com",
    "apiToken": "<Jira API Token>"
  }
  ```
  可复制 `jira.config.example.json`（已提交，含占位符）为 `jira.config.json` 填入真实值。
- **settings 配置**（正式部署用，由 base profile 的 settings-file 提供，`$DSH_HOME/settings.yaml`）：
  ```yaml
  jira:
    baseUrl: https://your-jira.example
    email: you@example.com
    apiToken: <Jira API Token>
  ```
  两处都未配置时插件照常加载，`jira/todos` 端点返回 `jira-not-configured`，客户端显示 `Jira: jira-not-configured` 提示条。
- **宿主端点**：`/hello/jira/todos` 调用 `GET {baseUrl}/rest/api/3/search/jql`（Basic Auth，10 秒超时），JQL 为 `assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC`，每项映射为 `{ key, summary, typeName, typeColor, typeIconUrl, statusName }` —— 类型颜色按名称匹配常见中英文 Jira 类型，其余从色板确定性取值；相对图标路径自动拼接 baseUrl。
- **客户端**：挂载后自动加载待办，展示为悬浮卡片「我的待办」列表；头部右侧有刷新按钮（⟳），点击刷新列表；每项为类型徽章（图标或代表色圆点 + 类型名）+ 摘要 + `KEY · 状态`；点击底部 hello 按钮 ping 宿主并刷新待办；调用失败显示红色错误条。

## LLM 分析与评论

点击某个待办项，可以让 LLM 分析该 issue 的内容，并选择是否把分析结论作为评论写回 Jira：

- **LLM 配置**（工程根 `llm.config.json`，已 gitignore，模板见 `llm.config.example.json`）：
  ```json
  {
    "provider": "deepseek-official",
    "model": "deepseek-chat"
  }
  ```
  未配置时 `jira/analyze` 端点返回错误提示。
- **分析端点**：`/hello/jira/analyze`（`{ args: { key } }`）。host 先读 issue 详情（summary + description + 已有评论，ADF 转纯文本），再调 `ctx.llm.stream`（`BlockAssembler` 聚合输出）生成分析文本，返回 `{ key, summary, analysis }`。LLM 服务用 `ctx.get('llm')` 可选获取，宿主未挂载 llm 时返回明确错误。
- **评论端点**：`/hello/jira/comment`（`{ args: { key, text } }`）。`POST {baseUrl}/rest/api/3/issue/{key}/comment`，body 用 ADF 格式。
- **客户端交互**：点击待办项 → 出现「LLM 正在分析…」面板 → 展示分析文本 + 「添加到评论 / 取消」按钮 → 同意则写回 Jira 并显示「✅ 已添加到 Jira 评论」。

## Google 新闻会话（Agent 新会话）

点击悬浮区域独立的「📰 获取新闻」按钮（青色，与 hello 按钮并列），宿主会发起一个**新会话**，会话里的 Agent 通过工具获取最新 Google 新闻并总结 —— LLM 交互全过程都在这个新会话中，dsh Web UI 的会话列表会自动出现该会话，点开即可查看完整过程：

- **宿主端点**：`/hello/news/start`（`{ args: {} }`）。`ctx.agents.create()` 创建新会话（sessionId `news-<uuid>`，agentOptions 取 `llm.config.json` 的 provider/model）→ `ctx.sessionTitle.rename()` 命名「获取新闻 <HH:mm:ss>」→ `setup` 中注册**作用域工具** `google_news` → `agent.followup()` 让 Agent 获取新闻并总结 → 立即返回 `{ sessionId }`（不等待完成，会话后台运行）。
- **工作区分组**：`workspaceRegistry.create(cwd, '新闻头条')` 创建/复用「新闻头条」工作区（`setTitle` 固定显示名）→ `attachSession(sessionId)` 把会话归入该工作区，dsh Web UI 会话列表按「新闻头条」分组显示。
- **google_news 工具**：抓取 `https://news.google.com/rss?hl=...`。**支持 HTTP 代理**：优先走 Node 全局 fetch；环境配置了 `HTTPS_PROXY`/`HTTP_PROXY`（兼容小写）/`ALL_PROXY` 且目标不在 `NO_PROXY` 内时，经代理链路抓取（https 目标走 CONNECT 隧道，纯 Node 内建实现，无新增运行时依赖），自动跟随重定向。正则解析 `<item>` 的标题/链接/发布时间，取前 15 条。工具通过 `ctx.tools.register` 从 agentCtx 注册（`ScopedLayers` 作用域机制），**仅该会话的 Agent 可见**，不污染全局工具表。
- **会话可见性**：宿主创建会话自动触发 `api-session/added` Remote 事件，dsh Web UI 会话列表自动出现新会话（无需客户端刷新）；点开可见 user/message → google_news 工具调用（tool/call + tool/result 含新闻列表）→ assistant 总结的完整交互。
- **客户端**：悬浮区域独立「📰 获取新闻」按钮（请求中显示「获取中…」）→ 调用 `news/start` → 按钮上方显示「✅ 已创建会话 <id>，在会话列表查看 Agent 总结」；失败显示红色错误条（如 `llm-not-configured`）。
- 需要 `llm.config.json` 配置 provider/model；Google News RSS 抓取无需任何 key。

## 宿主主动推送到客户端（长轮询）

`dsh` 的标准「宿主 → 客户端」事件推送走 api-gateway 的 Remote events 转发（`ctx.emit` → 网关广播 → 客户端 `ctx.remote.$on`）。但它依赖应用级 `api-remotes` 的 allowlist，且 `typertGateway.registerRemoteEvents` 是**单例**（已被 `api-remotes` 占用）—— 第三方插件的自定义事件名无法进 allowlist。

因此本插件采用**长轮询**复用已验证的 `/hello` 通道实现反向推送，不改 harness：

- **宿主端**：维护一个事件队列 `pending` + 挂起等待者 `waiters`。`emit(event, args)` 把事件入队并唤醒所有挂起的 poll。`/hello/events/poll` 端点：有事件立即返回全部，无事件则挂起等待（15 秒超时返回空数组，abort 时清理等待者）。语义是**广播**：一个事件被多个并发 poll 各自看到。
- **客户端**：`HelloPill` 挂载后启动长轮询循环，反复 `connection.rpc.call('/hello', 'events/poll', { args: {} })`。收到空数组立即发起下一次（保持一个常驻等待连接）；收到事件则展示为按钮上方的气泡条（**只保留最新一条**）；传输失败退避 3 秒重试。

宿主每 5 秒自动 emit 一个 `hello/notice` 事件，无需任何客户端操作即可在 Web 端持续看到气泡 —— 这就是「host 主动触发事件到 client」。

长轮询核心逻辑已用独立脚本验证（5 场景：等待中唤醒、多 waiter 广播、超时、abort、已有事件立即返回）。

## 本机 Chrome 调试远端客户端

当 VS Code 通过 Remote-SSH 连接远端主机时，DSH 服务与源码在远端，而 Chrome 在本机。先用 `DSH Web（hello-plugin patch）` 启动远端服务；再通过 VS Code 的「端口」视图将远端 `3080` 转发到本机，或在本机执行：

```sh
ssh -L 3080:127.0.0.1:3080 <remote-host>
```

在本机 Chrome 打开 `http://127.0.0.1:3080`，按 `F12` 打开 DevTools，在「Sources」中搜索 `index.tsx` 并设置断点。`pnpm build` 生成的 `lib/client.js.map` 会将该 bundle 映射回 `src/client/index.tsx`；修改客户端后需重新执行 `pnpm build` 并刷新页面。

## 验证过的 dsh 能力

这个插件是 dsh 双面插件的「接线图 + 边界探针」—— 每个功能都对应一条实际走通的 dsh 能力。按 [docs/hello-plugin-capabilities.md](docs/hello-plugin-capabilities.md)（已使用 ✅ / 未使用 ⬜ 的完整清单）与 [plugin-capability-catalog.md](plugin-capability-catalog.md)（能力全目录）梳理，**已实际使用 10 项**：

| 能力 | 插件里的体现 | 顺带验证的约束 |
| --- | --- | --- |
| **双面插件模型 + 加载** | `exports["."]` / `exports["./client"]` 两个半区；`dsh.client.platform=web` 扫描发现；ModuleLoader 惰性注册 | `load({ id })` 的 **id 必须等于包名**（图行 id） |
| **Cordis 内核** | `name`+`apply(ctx)`、`inject` 依赖注入、`ctx.effect` 生命周期、`ctx.logger`、`ctx.get` 可选获取 | 一切注册包进 `ctx.effect()`；服务缺失用 `ctx.get` 容错 |
| **Unary RPC**（客户端 → 宿主） | `connection.rpc.call('/hello', 'ping'…)` → `rpc.handle` handler | payload 信封 `{ args }`；结果 `{ ok, value } \| { ok, error }`；**`/api` 被 api-gateway 独占**，自定义通道须另开 |
| **长轮询**（宿主 → 客户端） | `pending` 队列 + `waiters` 挂起表，`events/poll` 广播推送 | 标准 Remote events 转发对自定义事件不适用：`registerRemoteEvents` 是单例 + 事件名须进 allowlist —— 改用长轮询 |
| **Agent 会话** | `ctx.agents.create` + `agent.followup` + `whenIdle`，驱动 Agent 获取新闻并总结 | 宿主建会话自动触发 `api-session/added` → Web UI 会话列表可见 |
| **作用域工具** | `ctx.tools.register` 从 agentCtx 注册 `google_news`（ScopedLayers） | 仅该会话 Agent 可见，不污染全局；parameters 须**完整 JSON Schema**（简写被模型 API 拒绝） |
| **LLM 直连** | `ctx.llm.stream` + `BlockAssembler` 分析 Jira issue | `ctx.get('llm')` 缺失时返回明确错误，插件照常加载 |
| **会话命名 / 工作区分组** | `ctx.sessionTitle.rename`；`workspaceRegistry.create` + `setTitle` + `attachSession` | 会话归入「新闻头条」工作区分组显示 |
| **settings 与工程配置** | `ctx.settings` 注册 jira namespace；工程根 `jira.config.json` / `llm.config.json` 逐级查找 | 工程配置优先于全局 settings；凭据不提交 |
| **插槽与 UI** | `ctx.slots` 注入 `HelloPill` 到 `shell.overlay`（inject 业务面把服务变组件 props） | 组件只靠 props、永不引用模块级 ctx；**组件必须直接传**（非包装函数） |

**三类能力供插件扩展但本插件刻意未用**：Typert Remote（生成式）/ Remote events（allowlist）/ WebSocket mux —— 均因 harness 独占约束选择自定义通道实现，详见「[客户端调用宿主](#客户端调用宿主)」「[宿主主动推送](#宿主主动推送到客户端长轮询)」章节的选型理由。

## 开发日志

- **2026-09-01 README 新增「验证过的 dsh 能力」章节** — 概要整理本插件实际使用（10 项）与刻意未用（3 项）的 dsh 能力，指向详尽的 `docs/hello-plugin-capabilities.md` 与能力全目录；结构表补充 capabilities 文档；详见 [开发日志](docs/dev-log.md)。
- **2026-09-01 fetchGoogleNews 支持 HTTP 代理** — 按 curl 语义读取 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（兼容小写）与 `NO_PROXY`；代理链路纯 Node 内建实现（https 走 CONNECT 隧道、http 走绝对 URI 形式，含 Basic 认证、重定向跟随、chunked 解码），无代理时行为不变；详见 [开发日志](docs/dev-log.md)。
- **2026-09-01 扩展 Jira 能力并注册全局工具** — `src/host/jira.ts` 新增搜索/创建/状态变更函数；新建 `src/host/jira-tools.ts` 注册 6 个全局 Jira 工具（jira_search_issues、jira_get_issue、jira_create_issue、jira_add_comment、jira_update_status、jira_get_transitions）；详见 [开发日志](docs/dev-log.md)。
- **2026-09-01 新建 hello-plugin dsh 能力全景文档** — 新建 `docs/hello-plugin-capabilities.md`，按 `plugin-capability-catalog.md` 类别体系系统梳理已使用（10 项）及未使用（50+ 项）能力，标注源码位置与潜在用途；详见 [开发日志](docs/dev-log.md)。
- **2026-09-01 新增 AGENTS.md 并修正 CLAUDE.md 入口文件路径** — 新增 `AGENTS.md`（Repository layout、Commands、Conventions、Defensive patterns、Type safety and documentation）；修正 `CLAUDE.md` 客户端入口 `index.tsx` → `index.ts`，补充 Panel 组件与最小化行为说明；详见 [开发日志](docs/dev-log.md)。
- **2026-09-01 按功能模块拆分 client 和 host 源码** — client 按 UI 组件拆分为 `types.ts` + `components/*`（TodoItem、TodoCard、AnalysisPanel、EventBubbles、NewsStatus、NewsButton、HelloButton、HelloPill），host 按功能域拆分为 `types.ts`、`constants.ts`、`errors.ts`、`config.ts`、`jira.ts`、`llm.ts`、`news.ts`；tsconfig 改用 `Bundler` moduleResolution，消除内部模块 `.js` 扩展名要求；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 工作区分组「新闻头条」，会话标题复原** — 新会话经 `workspaceRegistry.create(cwd, '新闻头条')` + `attachSession` 归入「新闻头条」工作区；会话标题恢复为「获取新闻 <HH:mm:ss>」；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 新闻会话分组名称改为「新闻头条」** — 会话标题前缀由「获取新闻」改为「新闻头条」（仍带时间戳）；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 新闻会话命名「获取新闻 + 时间」** — `news/start` 创建会话后经 `ctx.sessionTitle.rename` 命名「获取新闻 <HH:mm:ss>」，固定标题显示在会话列表；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 获取新闻入口独立为悬浮按钮** — 「📰 获取新闻」从待办卡片 header 移出，成为与 hello 按钮并列的独立按钮（青色），新闻提示条独立显示；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 修复 google_news 工具 schema 被模型 API 拒绝** — 工具 parameters 从简写改为完整 JSON Schema（`type: 'object'` + properties），否则模型 API 报 `type: null`；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 客户端点击发起新会话：Agent 获取 Google 新闻并总结** — 「📰 获取新闻」按钮 → 宿主 `ctx.agents.create` 发起新会话（`news-<uuid>`），setup 中注册作用域工具 `google_news`（抓取 Google News RSS）→ Agent 获取最新新闻并总结；新会话自动出现在 Web UI 会话列表（api-session/added），可查看完整 LLM 交互；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 LLM 分析与评论** — 点击待办项 → host 取 issue 详情（ADF 转文本）→ `ctx.llm.stream` 生成分析 → 客户端卡片内确认 → 同意则 ADF 格式写回 Jira 评论；LLM 配置走工程根 `llm.config.json`（provider/model，可配置），dsh-llm 改为 external 运行时依赖；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 客户端交互优化** — 长轮询气泡只保留最新一条；「我的待办」头部新增 ⟳ 刷新按钮；hello 按钮 ping 后 1 秒恢复 `hello world x{n}` 并计数 +1；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 恢复长轮询与 ping（学习项目只增不删）** — 上轮待办改动误删长轮询，已完整恢复（`events/poll` + 每 5 秒 `hello/notice` 推送 + 客户端气泡条），与待办列表、ping 共存；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 Jira 待办列表（替代类别条）** — host 改用 `/rest/api/3/search/jql` 查询指派给我的未解决 issue，新增 `/hello/jira/todos` 端点；客户端展示「我的待办」列表（类型徽章内嵌）替代类别条；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 Jira 配置支持放工程内（jira.config.json 优先）** — host 从工程根读取 `jira.config.json`（gitignore，含示例模板 `jira.config.example.json`），优先于全局 settings.yaml；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 宿主半区迁移为 TypeScript + 读取 Jira Issue Type** — `host.js` 迁为 `src/host/index.ts`（构建为 `lib/host.js` Node ESM 单文件），并通过 `ctx.settings` 注册 `jira` namespace、新增 `/hello/jira/issue-types` 端点；客户端点击按钮时渲染 Jira 类别条；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 支持本机 Chrome 调试远端客户端 TSX** — bundle source map 直接映射到 TSX，并记录 Remote-SSH 下通过端口转发使用本机 DevTools 的流程；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 增加 DeepSeek Harness Web 调试启动项** — 新增 VS Code 配置，在 `deepseek-harness` 中以 `dev.patch.yml` 运行 `pnpm dsh web`；详见 [开发日志](docs/dev-log.md)。
- **2026-08-31 客户端迁移为 TypeScript 并提供浏览器构建** — 新增 `tsc` + `tsdown` 构建，将客户端产物改为 `lib/client.js`；详见 [开发日志](docs/dev-log.md)。

完整记录见 [docs/dev-log.md](docs/dev-log.md)（每次功能 / BUG 修改 / 实现一条，最新在上）。此处为简述（最新在上）：

- **2026-08-28 整理学习路径并移除 HTML 手册** — 新增 `docs/learning-path.md`（4 阶段 11 章由简入深）；删除两份 HTML 手册，docs 全部为 Markdown。
- **2026-08-28 README 增加开发日志简述章节** — README 新增「开发日志」章节，与 dev-log.md 同步；规则：更新日志时同时更新简述。
- **2026-08-28 建立开发日志机制** — 新增 `docs/dev-log.md` 与 CLAUDE.md 的「开发日志（强制）」规则，补录全部历史条目；同 commit 修复客户端长轮询循环只跑一轮的 bug（`inflight` 未复位）。
- **2026-08-28 hello/notice 改为每 5 秒推送** — `host.js` 用 `setInterval` 替代一次性 `setTimeout`，持续演示 host 主动推送。
- **2026-08-28 新增插件能力清单** — `docs/plugin-capability-catalog.*` 整理 dsh 对 plugin 开放的全部能力面；`cordis.patch.yml` 改用可移植包名。
- **2026-08-28 宿主主动推送事件到客户端** — `/hello` 通道长轮询（广播语义、15s 超时、abort 清理），客户端常驻 poll 循环。
- **2026-08-28 客户端点击调用宿主** — 接通 `/hello` RPC；修复组件引用模块级 `ctx` 的作用域 bug（改走 slots inject 业务面）。
- **2026-08-28 插件初始化** — 双面插件骨架：宿主日志 + 客户端悬浮按钮 + 插槽注入。

## 开发与验证

构建与验证（两个半区都是 TypeScript，构建产物在 `lib/`）：

1. 构建（TypeScript 检查 + 双半区打包）：
   ```sh
   pnpm build
   node --check lib/host.js lib/client.js
   ```
2. 启动一个挂载了本 bundle 的 dsh profile（`dev.patch.yml` 指向 `lib/host.js`），宿主端应能看到日志 `hello-plugin/host.js loaded` 与 `host loaded`；Web 端右下角出现「我的待办」悬浮卡片。
3. 点击底部 hello 按钮：宿主端日志追加 `client ping: browser`，按钮文本短暂变为 `pong from host, hello browser!`，**1 秒后恢复 `hello world x{n}`（计数 +1）** —— 表示客户端 → 宿主的 RPC 链路打通。
4. 宿主每 5 秒（无需操作）Web 端按钮上方出现新的气泡条 `hello/notice: host is alive at ...`，宿主日志追加 `emit: hello/notice ...` —— 表示宿主 → 客户端的推送链路（长轮询）打通。
5. 配置 Jira 凭据（任选其一，工程文件优先）后，卡片展示「我的待办」列表（每项含类型徽章 + 摘要 + `KEY · 状态`）；未配置时显示 `Jira: jira-not-configured` 提示条。开发时在工程根放 `jira.config.json`（见 `jira.config.example.json`）即可，无需改全局 settings.yaml。
6. 在工程根放 `llm.config.json`（见 `llm.config.example.json`）配置 provider/model 后，点击某个待办项：出现「LLM 正在分析…」→ 展示分析面板 → 点「添加到评论」写回 Jira 并显示「✅ 已添加到 Jira 评论」；未配置 LLM 时显示分析失败提示。
7. 点击「📰 获取新闻」按钮：按钮上方显示「✅ 已创建会话 news-xxx，在会话列表查看 Agent 总结」；dsh Web UI 会话列表自动出现该会话，点开可见完整 LLM 交互（user/message → google_news 工具调用含新闻列表 → assistant 总结）。未配置 LLM 时显示 `llm-not-configured` 错误条。

客户端半区在 dev 模式下由 harness 的 `scripts/dev-web.ts` watch 构建（按 `dsh.client` 扫描发现），改动后无需手动打包。

## 注意（与包名不一致处）

- `dev.patch.yml` 中 `name` 是绝对路径 `../hello-plugin/lib/host.js`，仅在本机有效。若要跨机器/作为依赖安装使用，应改为可移植的引用（正式 patch `cordis.patch.yml` 已用包名 `dsh-hello-plugin`，保持可移植）。
