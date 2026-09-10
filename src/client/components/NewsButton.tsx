import * as React from 'react'

interface NewsButtonProps {
  newsLoading: boolean
  onStartNews: () => void
}

export function NewsButton({ newsLoading, onStartNews }: NewsButtonProps): React.ReactElement {
  return React.createElement('button', {
    onClick: onStartNews,
    disabled: newsLoading,
    title: newsLoading
      ? 'Agent 正在获取新闻，结束后可再次点击'
      : '获取 Google 最新新闻并总结（新会话）',
    style: {
      border: 'none', borderRadius: '999px', padding: '8px 14px', fontSize: '13px',
      color: '#fff', background: newsLoading ? '#0e7a8c' : '#0e93ab',
      cursor: newsLoading ? 'not-allowed' : 'pointer',
      opacity: newsLoading ? 0.75 : 1,
    },
  }, newsLoading ? '正在获取…' : '📰 获取新闻')
}
