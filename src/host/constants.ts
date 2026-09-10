export const name = 'dsh-hello-plugin'

// 依赖 connection 服务（宿主端由 client-connection 提供），用它注册 RPC 通道，
// 供浏览器客户端通过 ctx.connection.rpc.call 调用。settings 服务由 base profile
// 的 settings-file 提供，这里用 ctx.get 可选获取（拿不到也能加载插件）。
// agents 服务（core/agent）用于创建新会话驱动 Agent；sessionTitle 用于给会话命名；
// workspaceRegistry 用于把会话归入「新闻头条」工作区；
// tools 服务用于注册全局工具（Jira 工具）。
// 注：webServer 是**自建 /hello 通道的路由挂载点**（见 src/host/web-channel.ts）——
// 当前 harness 版本的 `connection.rpc.handle` 把通道挂到 connection 插件自身 ctx 的
// webServer 上，消费方够不着（调用即抛 `cannot get property "webServer" without inject`），
// 故本插件在自己的 webServer 上注册前缀路由并复用 connection 的信任/鉴权栅栏。
export const inject = ['connection', 'webServer', 'agents', 'sessionTitle', 'workspaceRegistry', 'tools']

// 长轮询超时：客户端挂起一个 poll 请求，宿主在超时内等不到新事件就返回空数组。
// 客户端收到空数组后立即发起下一次 poll —— 有事件时近乎实时，无事件时只挂一个请求。
export const POLL_TIMEOUT_MS = 15_000

// Jira 常见 Issue Type 的代表色（按名称精确匹配）；其余按名称 hash 从色板取色。
export const ISSUE_TYPE_COLORS: Readonly<Record<string, string>> = {
  Bug: '#d04437',
  'Bug (Defect)': '#d04437',
  Task: '#3572b0',
  Story: '#16825d',
  Epic: '#7a3e9d',
  Improvement: '#1d8b8b',
  'Sub-task': '#8c9bac',
  SubTask: '#8c9bac',
  // 常见中文 Issue Type 名（Jira Cloud 中文界面）
  故事: '#16825d',
  任务: '#3572b0',
  缺陷: '#d04437',
  史诗: '#7a3e9d',
  改进: '#1d8b8b',
  子任务: '#8c9bac',
}

export const FALLBACK_COLORS: readonly string[] = [
  '#5a67d8', '#38a169', '#dd6b20', '#d69e2e', '#e53e3e', '#319795', '#805ad5', '#d53f8c',
]
