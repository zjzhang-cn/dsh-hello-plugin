import * as React from 'react'

interface NewsStatusProps {
  newsLoading: boolean
  newsSession: string | null
  newsError: string | null
}

export function NewsStatus({ newsLoading, newsSession, newsError }: NewsStatusProps): React.ReactElement {
  return React.createElement(React.Fragment, null,
    ...(newsError !== null
      ? [React.createElement('div', {
          key: 'news-error',
          style: {
            background: 'rgba(214,69,64,0.1)', border: '1px solid rgba(214,69,64,0.35)',
            borderRadius: '8px', padding: '6px 10px', fontSize: '12px', maxWidth: '300px',
            color: '#d64540',
          },
        }, `Google 新闻：${newsError}`)]
      : []),
    ...(newsSession === null
      ? []
      : [React.createElement('div', {
          key: 'news-session',
          style: {
            background: newsLoading ? 'rgba(14,147,171,0.08)' : 'rgba(22,130,93,0.08)',
            border: `1px solid ${newsLoading ? 'rgba(14,147,171,0.35)' : 'rgba(22,130,93,0.35)'}`,
            borderRadius: '8px', padding: '6px 10px', fontSize: '12px', maxWidth: '300px',
            color: newsLoading ? '#0e7a8c' : '#16825d',
          },
        }, newsLoading
          ? `⏳ Agent 正在获取新闻（会话 ${newsSession}），完成后按钮恢复可点击`
          : `✅ 已创建会话 ${newsSession}，在会话列表查看 Agent 总结`)]),
  )
}
