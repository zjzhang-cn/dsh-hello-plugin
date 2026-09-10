/** 长轮询事件。 */
export interface PendingEvent {
  event: string
  args: unknown[]
}

/** Jira 连接配置。 */
export interface JiraSettings {
  baseUrl?: string | undefined
  email?: string | undefined
  apiToken?: string | undefined
}

/** LLM 配置。 */
export interface LlmConfig {
  provider?: string | undefined
  model?: string | undefined
}

/** 一条 Jira 待办（指派给当前用户的未解决问题）。 */
export interface JiraTodo {
  key: string
  summary: string
  typeName: string
  typeColor: string
  typeIconUrl: string
  statusName: string
}

/** Jira issue 详情（供 LLM 分析用）。 */
export interface JiraIssueDetail {
  key: string
  summary: string
  descriptionText: string
  commentsText: string
}

/** Google News 新闻条目。 */
export interface GoogleNewsItem {
  title: string
  link: string
  pubDate: string
}

/** 最近一次新闻会话的状态（/hello/news/status 返回值，供客户端兜底核对按钮禁用态）。 */
export interface NewsStatus {
  sessionId: string
  state: 'running' | 'done' | 'failed'
  error?: string
}

/** 配置文件加载器的日志接口。 */
export interface ConfigLoaderLogger {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}
