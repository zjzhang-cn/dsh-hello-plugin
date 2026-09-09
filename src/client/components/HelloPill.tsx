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

  const startNewsSession = (): void => {
    if (newsLoading) return
    setNewsLoading(true)
    setNewsError(null)
    void connection.rpc
      .call('/hello', 'news/start', { args: {} })
      .then((result) => {
        if (result.ok) setNewsSession((result.value as { sessionId: string }).sessionId)
        else setNewsError(`${result.error.code}: ${result.error.message}`)
      })
      .catch((error: unknown) => setNewsError(String(error)))
      .finally(() => setNewsLoading(false))
  }

  React.useEffect(() => {
    loadTodos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection])

  React.useEffect(() => {
    let cancelled = false
    let inflight = false
    async function poll(): Promise<void> {
      if (cancelled || inflight) return
      inflight = true
      try {
        const result = await connection.rpc.call('/hello', 'events/poll', { args: {} })
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
          React.createElement(NewsStatus, { newsSession, newsError }),
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
