import * as React from 'react'
import type { JiraAnalysis } from '../types'

interface AnalysisPanelProps {
  analysis: JiraAnalysis | null
  analysisLoading: boolean
  analysisError: string | null
  /** 分析会话已创建时的提示文案（等待 Agent 完成期间展示）。 */
  sessionHint: string | null
  commentState: 'idle' | 'submitting' | 'added' | 'error'
  commentError: string | null
  onAddComment: () => void
  onCancel: () => void
}

export function AnalysisPanel({
  analysis,
  analysisLoading,
  analysisError,
  sessionHint,
  commentState,
  commentError,
  onAddComment,
  onCancel,
}: AnalysisPanelProps): React.ReactElement | null {
  if (analysisLoading) {
    return React.createElement('div', {
      key: 'analysis-loading',
      style: {
        background: 'rgba(255,255,255,0.96)', border: '1px solid rgba(0,0,0,0.12)',
        borderRadius: '10px', width: '300px', padding: '10px 12px', fontSize: '12px',
        color: '#6a7c99',
      },
    },
    React.createElement('div', null, 'Agent 正在分析…'),
    sessionHint !== null
      ? React.createElement('div', {
          style: { marginTop: '4px', fontSize: '11px', color: '#94a3b8' },
        }, sessionHint)
      : null)
  }

  if (analysisError !== null) {
    return React.createElement('div', {
      key: 'analysis-error',
      style: {
        background: 'rgba(214,69,64,0.1)', border: '1px solid rgba(214,69,64,0.35)',
        borderRadius: '10px', width: '300px', padding: '10px 12px', fontSize: '12px',
        color: '#d64540',
      },
    }, `分析失败：${analysisError}`)
  }

  if (analysis === null) return null

  return React.createElement('div', {
    key: 'analysis-panel',
    style: {
      background: 'rgba(255,255,255,0.96)', border: '1px solid rgba(79,124,255,0.4)',
      borderRadius: '10px', width: '300px', padding: '10px 12px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
    },
  },
  React.createElement('div', {
    style: { fontSize: '12px', fontWeight: 600, color: '#1e293b', marginBottom: '4px' },
  }, `${analysis.key} · ${analysis.summary}`),
  React.createElement('div', {
    style: {
      fontSize: '12px', color: '#334155', maxHeight: '180px', overflowY: 'auto',
      whiteSpace: 'pre-wrap', marginBottom: '8px',
    },
  }, analysis.analysis),
  commentState === 'added'
    ? React.createElement('div', {
        style: { fontSize: '12px', color: '#16825d' },
      }, '✅ 已添加到 Jira 评论')
    : React.createElement('div', {
        style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
      },
    React.createElement('button', {
      onClick: onCancel,
      disabled: commentState === 'submitting',
      style: {
        border: '1px solid rgba(0,0,0,0.15)', borderRadius: '6px', padding: '4px 10px',
        fontSize: '12px', background: 'transparent', color: '#475569', cursor: 'pointer',
      },
    }, '取消'),
    React.createElement('button', {
      onClick: onAddComment,
      disabled: commentState === 'submitting',
      style: {
        border: 'none', borderRadius: '6px', padding: '4px 10px',
        fontSize: '12px', color: '#fff', background: '#4f7cff', cursor: 'pointer',
      },
    }, commentState === 'submitting' ? '添加中…' : '添加到评论')),
  ...(commentState === 'error'
    ? [React.createElement('div', {
        key: 'comment-error',
        style: { fontSize: '12px', color: '#d64540', marginTop: '6px' },
      }, `评论失败：${commentError}`)]
    : []))
}
