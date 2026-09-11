import * as React from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { JiraTodo, JiraAnalysis } from '../types'
import { TodoCard } from './TodoCard'
import { AnalysisPanel } from './AnalysisPanel'
import { EventBubbles } from './EventBubbles'
import { NewsStatus } from './NewsStatus'
import { NewsButton } from './NewsButton'
import { HelloButton } from './HelloButton'
import { Panel } from './Panel'

/** 宿主推送的分析完成事件 payload（jira/analysis-done）。 */
interface AnalysisDonePayload {
  key: string
  summary: string
  analysis: string
  sessionId: string
}

/** 宿主推送的分析失败事件 payload（jira/analysis-failed）。 */
interface AnalysisFailedPayload {
  sessionId: string
  message: string
}

/** 宿主推送的新闻会话结束事件 payload（news/done | news/failed）。 */
interface NewsSettledPayload {
  sessionId: string
  message?: string
}

/** /hello/agent/status 返回的新闻会话状态（活跃 Agent 实时状态，或最近一次会话的权威状态）。 */
interface NewsStatusPayload {
  sessionId: string
  state: 'running' | 'done' | 'failed'
  error?: string
}

/** 事件长轮询的单次请求上限：宿主挂起 15 秒，留出余量后超时。 */
const POLL_ABORT_MS = 20_000
/** news/start 的请求上限：只做建会话 + 发消息，正常秒级返回；超时视为失败放开按钮。 */
const START_ABORT_MS = 30_000

interface HelloPillProps {
  connection: ConnectionHandle
}

export function HelloPill({ connection }: HelloPillProps): React.ReactElement {
  const [count, setCount] = React.useState(0)
  const [reply, setReply] = React.useState<string | null>(null)
  const [todos, setTodos] = React.useState<JiraTodo[] | null>(null)
  const [todosError, setTodosError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [events, setEvents] = React.useState<string[]>([])
  const replyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickSeqRef = React.useRef(0)
  const [analysis, setAnalysis] = React.useState<JiraAnalysis | null>(null)
  const [analysisLoading, setAnalysisLoading] = React.useState(false)
  const [analysisError, setAnalysisError] = React.useState<string | null>(null)
  const [analysisSessionId, setAnalysisSessionId] = React.useState<string | null>(null)
  // 最近一次发起且未决的分析会话 id：宿主推送的 done/failed 事件只在 sessionId 匹配时生效，
  // 防止旧会话的结果覆盖新一次点击（同一待办被点击多次时按会话区分）
  const pendingAnalysisSessionRef = React.useRef<string | null>(null)
  const [commentState, setCommentState] = React.useState<'idle' | 'submitting' | 'added' | 'error'>('idle')
  const [commentError, setCommentError] = React.useState<string | null>(null)
  const [newsSession, setNewsSession] = React.useState<string | null>(null)
  const [newsLoading, setNewsLoading] = React.useState(false)
  const [newsError, setNewsError] = React.useState<string | null>(null)
  // 最近一次发起且未结束的新闻会话 id：宿主在 Agent 会话静止后推 news/done / news/failed，
  // 只有匹配该 id 的事件才解除按钮禁用（防止旧会话的结束事件提前放行新的请求）
  const pendingNewsSessionRef = React.useRef<string | null>(null)
  // 结束事件先于 news/start 响应抵达时暂存的结果（只留最近 5 条），供 startNewsSession 核对
  const settledNewsRef = React.useRef<Array<{ sessionId: string; error: string | null }>>([])
  // 未决会话 id 的确立时刻：用于判定「宿主重启后 /agent/status 查不到会话」（见看门狗）
  const pendingNewsSinceRef = React.useRef<number | null>(null)
  const [isMinimized, setIsMinimized] = React.useState(false)

  const loadTodos = (): void => {
    if (loading) return
    setLoading(true)
    setTodosError(null)
    void connection.rpc
      .call('/hello', 'jira/todos', { args: {} })
      .then((result) => {
        if (result.ok) {
          setTodos(result.value as JiraTodo[])
        } else {
          setTodosError(`${result.error.code}: ${result.error.message}`)
        }
      })
      .catch((error: unknown) => setTodosError(String(error)))
      .finally(() => setLoading(false))
  }

  const analyzeTodo = (todo: JiraTodo): void => {
    if (analysisLoading) return
    setAnalysisLoading(true)
    setAnalysisError(null)
    setAnalysis(null)
    setAnalysisSessionId(null)
    pendingAnalysisSessionRef.current = null
    setCommentState('idle')
    setCommentError(null)
    void connection.rpc
      .call('/hello', 'jira/analyze', { args: { key: todo.key } })
      .then((result) => {
        if (result.ok) {
          // 宿主已创建 Agent 会话（左侧「Jira 分析」工作区可见），保持 loading，
          // 分析结果 / 失败随后经 events/poll 事件推送
          const sessionId = (result.value as { sessionId?: unknown }).sessionId
          const id = typeof sessionId === 'string' ? sessionId : null
          pendingAnalysisSessionRef.current = id
          setAnalysisSessionId(id)
        } else {
          pendingAnalysisSessionRef.current = null
          setAnalysisError(`${result.error.code}: ${result.error.message}`)
          setAnalysisLoading(false)
        }
      })
      .catch((error: unknown) => {
        pendingAnalysisSessionRef.current = null
        setAnalysisError(String(error))
        setAnalysisLoading(false)
      })
  }

  const addComment = (): void => {
    if (analysis === null || commentState === 'submitting') return
    setCommentState('submitting')
    setCommentError(null)
    void connection.rpc
      .call('/hello', 'jira/comment', { args: { key: analysis.key, text: analysis.analysis } })
      .then((result) => {
        if (result.ok) setCommentState('added')
        else {
          setCommentState('error')
          setCommentError(`${result.error.code}: ${result.error.message}`)
        }
      })
      .catch((error: unknown) => {
        setCommentState('error')
        setCommentError(String(error))
      })
  }

  const cancelAnalysis = (): void => {
    setAnalysis(null)
    pendingAnalysisSessionRef.current = null
    setAnalysisSessionId(null)
    setCommentState('idle')
    setCommentError(null)
  }

  /**
   * 按宿主权威状态收敛新闻按钮：只有当「未决会话已结束」（或没有未决会话但最近一次已结束）
   * 时才解除禁用。事件（news/done / news/failed）与 /agent/status 兜底核对共用这段逻辑。
   */
  const settleNews = (status: NewsStatusPayload): void => {
    const pending = pendingNewsSessionRef.current
    // 必须有未决会话且 id 一致才收敛：否则刚点击、sessionId 还没回来的那一刻，
    // 上一轮的 done 状态会把按钮提前放开
    if (pending === null || status.sessionId !== pending) return
    if (status.state === 'running') return
    pendingNewsSessionRef.current = null
    pendingNewsSinceRef.current = null
    setNewsLoading(false)
    if (status.state === 'failed') {
      setNewsError(status.error !== undefined && status.error !== '' ? status.error : 'Agent 获取新闻失败')
    }
  }

  /** 标记一个未决新闻会话（RPC 返回 sessionId 或挂载同步时调用）。 */
  const trackPendingNews = (sessionId: string): void => {
    pendingNewsSessionRef.current = sessionId
    pendingNewsSinceRef.current = Date.now()
  }

  const startNewsSession = (): void => {
    if (newsLoading) return
    setNewsLoading(true)
    setNewsError(null)
    setNewsSession(null)
    pendingNewsSessionRef.current = null
    settledNewsRef.current = []
    void connection.rpc
      .call('/hello', 'news/start', { args: {} }, AbortSignal.timeout(START_ABORT_MS))
      .then((result) => {
        if (result.ok) {
          // 宿主已创建 Agent 会话并返回 sessionId，但 Agent 仍在运行：
          // 保持 newsLoading（按钮禁用、显示「正在获取…」），直到宿主推 news/done / news/failed
          const sessionId = (result.value as { sessionId?: unknown }).sessionId
          const id = typeof sessionId === 'string' ? sessionId : null
          setNewsSession(id)
          if (id === null) {
            setNewsLoading(false)
            return
          }
          // 竞态兜底：结束事件与本响应走两条不同的 HTTP 连接，顺序无保证。若 news/done /
          // news/failed 已先被 poll 收到（存入 settledNewsRef），这里就按暂存结果直接解除禁用，
          // 否则按钮会永久停在「正在获取…」
          const settled = settledNewsRef.current.find((item) => item.sessionId === id)
          if (settled !== undefined) {
            settledNewsRef.current = settledNewsRef.current.filter((item) => item.sessionId !== id)
            setNewsLoading(false)
            if (settled.error !== null) setNewsError(settled.error)
            return
          }
          pendingNewsSessionRef.current = id
          pendingNewsSinceRef.current = Date.now()
        } else {
          setNewsError(`${result.error.code}: ${result.error.message}`)
          setNewsLoading(false)
        }
      })
      .catch((error: unknown) => {
        setNewsError(String(error))
        setNewsLoading(false)
      })
  }

  React.useEffect(() => {
    loadTodos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])

  // 挂载时同步一次新闻状态：页面在 Agent 运行途中刷新时，按钮应保持禁用态
  React.useEffect(() => {
    let cancelled = false
    // 不带 sessionId：刷新后组件还不知道会话 id，宿主会返回最近一次新闻会话的权威状态
    // （其中 running 分支已是 Agent 的实时状态），是唯一的恢复入口
    void connection.rpc
      .call('/hello', 'agent/status', { args: {} })
      .then((result) => {
        if (cancelled || !result.ok) return
        const status = result.value as NewsStatusPayload | null
        if (status === null || status.state !== 'running') return
        trackPendingNews(status.sessionId)
        setNewsSession(status.sessionId)
        setNewsLoading(true)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [connection])

  // 兜底看门狗：事件可能丢失（页面刷新、长轮询请求中断、宿主重启），
  // 禁用期间每 3 秒用 /agent/status 核对一次 —— 带未决会话 id 时查的是活跃 Agent 的
  // 实时状态（status 变 idle 即结束），结束就恢复按钮，不会永久卡住
  React.useEffect(() => {
    if (!newsLoading) return
    let cancelled = false
    const timer = setInterval(() => {
      const pending = pendingNewsSessionRef.current
      void connection.rpc
        .call('/hello', 'agent/status', { args: pending === null ? {} : { sessionId: pending } })
        .then((result) => {
          if (cancelled || !result.ok) return
          const status = result.value as NewsStatusPayload | null
          if (status !== null) {
            settleNews(status)
            return
          }
          // 宿主重启 / 插件重载会丢掉内存里的状态：若未决会话已确立超过一个核对周期
          // 仍查不到记录，说明那次运行随宿主一起没了，直接恢复按钮（不再永久禁用）
          const since = pendingNewsSinceRef.current
          if (pendingNewsSessionRef.current !== null && since !== null && Date.now() - since > 6_000) {
            pendingNewsSessionRef.current = null
            pendingNewsSinceRef.current = null
            setNewsLoading(false)
          }
        })
        .catch(() => {})
    }, 3_000)
    return () => { cancelled = true; clearInterval(timer) }
    // settleNews 只读 ref 与 setState，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, newsLoading])

  React.useEffect(() => {
    let cancelled = false
    let inflight = false
    async function poll(): Promise<void> {
      if (cancelled || inflight) return
      inflight = true
      try {
        // 带上单次请求超时：宿主挂起 15 秒；若请求因宿主重启等原因悬住，
        // 超时会走 catch 分支重试，避免 inflight 永远为 true 把轮询循环卡死
        const result = await connection.rpc.call(
          '/hello', 'events/poll', { args: {} }, AbortSignal.timeout(POLL_ABORT_MS),
        )
        inflight = false
        if (!cancelled && result.ok && Array.isArray(result.value)) {
          const incoming = result.value as { event: string; args: unknown[] }[]
          // 按事件名分发：分析结果/失败事件消费掉（匹配未决 sessionId），其余维持气泡（只留最新一条）
          let bubble: string | null = null
          for (const item of incoming) {
            if (item.event === 'jira/analysis-done' || item.event === 'jira/analysis-failed') {
              const args = item.args[0] as Partial<AnalysisDonePayload & AnalysisFailedPayload> | undefined
              const sid = typeof args?.sessionId === 'string' ? args.sessionId : null
              if (sid === null || sid !== pendingAnalysisSessionRef.current) continue // 旧会话事件，丢弃
              pendingAnalysisSessionRef.current = null
              setAnalysisSessionId(null)
              setAnalysisLoading(false)
              if (item.event === 'jira/analysis-done') {
                setAnalysis({
                  key: args?.key ?? '',
                  summary: args?.summary ?? '',
                  analysis: args?.analysis ?? '',
                })
              } else {
                setAnalysisError(args?.message !== undefined && args.message !== ''
                  ? args.message
                  : 'Agent 分析失败')
              }
              continue
            }
            // 新闻会话结束（Agent 跑完 / 失败）：解除按钮禁用，恢复可再次点击
            if (item.event === 'news/done' || item.event === 'news/failed') {
              const args = item.args[0] as Partial<NewsSettledPayload> | undefined
              const sid = typeof args?.sessionId === 'string' ? args.sessionId : null
              if (sid === null) continue
              const error = item.event === 'news/failed'
                ? (args?.message !== undefined && args.message !== '' ? args.message : 'Agent 获取新闻失败')
                : null
              if (sid !== pendingNewsSessionRef.current) {
                // 结束事件先于 news/start 的响应抵达（两条连接顺序无保证）→ 暂存，交给 startNewsSession 核对
                settledNewsRef.current = [...settledNewsRef.current.slice(-4), { sessionId: sid, error }]
                continue
              }
              settleNews(item.event === 'news/failed'
                ? { sessionId: sid, state: 'failed', ...(error !== null ? { error } : {}) }
                : { sessionId: sid, state: 'done' })
              continue
            }
            bubble = `${item.event}: ${item.args.join(' ')}`
          }
          if (bubble !== null) setEvents([bubble])
        }
      } catch {
        inflight = false
        if (!cancelled) {
          setTimeout(poll, 3_000)
          return
        }
      }
      if (!cancelled) void poll()
    }
    void poll()
    return () => { cancelled = true }
  }, [connection])

  const clearReplyTimer = (): void => {
    if (replyTimerRef.current !== null) {
      clearTimeout(replyTimerRef.current)
      replyTimerRef.current = null
    }
  }

  React.useEffect(() => () => { clearReplyTimer() }, [])

  const onClick = (): void => {
    const seq = ++clickSeqRef.current
    clearReplyTimer()
    setReply('…')
    void connection.rpc
      .call('/hello', 'ping', { args: { name: 'browser' } })
      .then((result) => {
        if (seq !== clickSeqRef.current) return
        if (result.ok) setReply(String(result.value))
        else setReply(`error: ${result.error.code}: ${result.error.message}`)
      })
      .catch((error: unknown) => {
        if (seq !== clickSeqRef.current) return
        setReply(`error: ${String(error)}`)
      })
      .finally(() => {
        if (seq !== clickSeqRef.current) return
        replyTimerRef.current = setTimeout(() => {
          setReply(null)
          setCount((currentCount) => currentCount + 1)
          replyTimerRef.current = null
        }, 1_000)
      })
  }

  return React.createElement(
    'div',
    {
      style: {
        position: 'fixed', right: '16px', bottom: '16px', zIndex: 1000,
        display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px',
        fontFamily: 'system-ui, sans-serif',
      },
    },
    isMinimized
      ? React.createElement('button', {
          onClick: () => setIsMinimized(false),
          title: '展开面板',
          style: {
            border: 'none', borderRadius: '999px', width: '40px', height: '40px',
            fontSize: '16px', color: '#fff', background: '#4f7cff', cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center',
            justifyContent: 'center',
          },
        }, '□')
      : React.createElement(Panel, null,
          React.createElement('div', {
            style: {
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '0 4px 4px', borderBottom: '1px solid rgba(0,0,0,0.08)',
              fontSize: '12px', fontWeight: 600, color: '#1e293b',
            },
          },
          'Hello Plugin',
          React.createElement('button', {
            onClick: () => setIsMinimized(true),
            title: '最小化',
            style: {
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: '14px', color: '#6a7c99', padding: '0 4px',
            },
          }, '−')),
          React.createElement(TodoCard, {
            todos,
            loading,
            todosError,
            onRefresh: loadTodos,
            onItemClick: analyzeTodo,
          }),
          React.createElement(AnalysisPanel, {
            analysis,
            analysisLoading,
            analysisError,
            sessionHint: analysisSessionId === null
              ? null
              : `会话 ${analysisSessionId} 已创建，在左侧「Jira 分析」工作区可查看实时过程`,
            commentState,
            commentError,
            onAddComment: addComment,
            onCancel: cancelAnalysis,
          }),
          React.createElement(EventBubbles, { events }),
          React.createElement(NewsStatus, { newsLoading, newsSession, newsError }),
          React.createElement('div', {
            style: { display: 'flex', gap: '8px', alignItems: 'center' },
          },
          React.createElement(NewsButton, {
            newsLoading,
            onStartNews: startNewsSession,
          }),
          React.createElement(HelloButton, { reply, count, onClick })),
        ),
  )
}
