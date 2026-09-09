import { Version3Client } from 'jira.js'
import type { Document } from 'jira.js/version3/models'
import { ISSUE_TYPE_COLORS, FALLBACK_COLORS } from './constants'
import { JiraConfigError } from './errors'
import type { JiraSettings, JiraTodo, JiraIssueDetail } from './types'

function colorForIssueType(name: string): string {
  const exact = ISSUE_TYPE_COLORS[name]
  if (exact !== undefined) return exact
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  const index = hash % FALLBACK_COLORS.length
  return FALLBACK_COLORS[index] ?? FALLBACK_COLORS[0] ?? '#5a67d8'
}

function resolveIconUrl(baseUrl: string, iconUrl: string | undefined): string {
  if (iconUrl === undefined || iconUrl === '') return ''
  if (/^https?:\/\//i.test(iconUrl)) return iconUrl
  return baseUrl.replace(/\/+$/, '') + (iconUrl.startsWith('/') ? iconUrl : '/' + iconUrl)
}

function assertJiraSettings(settings: JiraSettings): void {
  if (settings.baseUrl === undefined || settings.baseUrl.trim() === '') throw new JiraConfigError('jira.baseUrl 未配置')
  if (settings.email === undefined || settings.email.trim() === '') throw new JiraConfigError('jira.email 未配置')
  if (settings.apiToken === undefined || settings.apiToken.trim() === '') throw new JiraConfigError('jira.apiToken 未配置')
}

function jiraBaseUrl(settings: JiraSettings): string {
  return (settings.baseUrl as string).replace(/\/+$/, '')
}

function createJiraClient(settings: JiraSettings): Version3Client {
  assertJiraSettings(settings)
  return new Version3Client({
    host: settings.baseUrl as string,
    authentication: {
      basic: {
        email: settings.email as string,
        apiToken: settings.apiToken as string,
      },
    },
  })
}

/** 把 Jira 的 ADF（Atlassian Document Format）节点递归转成纯文本。 */
function adfToText(node: unknown): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map((item) => adfToText(item)).join('\n')
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') return record.text
    if (record.type === 'hardBreak') return '\n'
    if (Array.isArray(record.content)) return adfToText(record.content)
    return ''
  }
  return ''
}

/** 调用 Jira REST API 读取指派给当前用户的未解决 issue（待办）。 */
export async function fetchJiraTodos(settings: JiraSettings): Promise<JiraTodo[]> {
  assertJiraSettings(settings)
  const baseUrl = jiraBaseUrl(settings)
  const client = createJiraClient(settings)
  const jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
    jql,
    fields: ['key', 'summary', 'issuetype', 'status'],
    maxResults: 50,
  })
  const issues = result.issues
  if (!Array.isArray(issues)) throw new Error('Jira API 返回结构异常（期望 issues 数组）')
  return issues.filter((issue) => typeof issue.key === 'string').map((issue) => {
    const fields = issue.fields
    const typeName = fields.issuetype?.name ?? fields.issueType?.name ?? 'Issue'
    return {
      key: issue.key,
      summary: fields.summary ?? '',
      typeName,
      typeColor: colorForIssueType(typeName),
      typeIconUrl: resolveIconUrl(baseUrl, fields.issuetype?.iconUrl ?? fields.issueType?.iconUrl ?? undefined),
      statusName: fields.status?.name ?? '',
    }
  })
}

/** 读取单个 issue 详情（summary + description + comments），供 LLM 分析。 */
export async function fetchJiraIssueDetail(settings: JiraSettings, key: string): Promise<JiraIssueDetail> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  const issue = await client.issues.getIssue({
    issueIdOrKey: key,
    fields: ['summary', 'description', 'comment'],
  })
  const fields = issue.fields
  const comments = fields.comment?.comments
  const commentsText = (Array.isArray(comments) ? comments : [])
    .map((comment) => {
      const author = typeof comment.author?.displayName === 'string' ? comment.author.displayName : 'unknown'
      const text = adfToText(comment.body).trim()
      return text === '' ? '' : `${author}: ${text}`
    })
    .filter((text) => text !== '')
    .join('\n')
  return {
    key: issue.key ?? key,
    summary: fields.summary ?? '',
    descriptionText: adfToText(fields.description).trim(),
    commentsText,
  }
}

/**
 * 轻量读取单个 issue 的 key + summary（不取 description/comments）。
 * 用于分析会话创建前的预检（校验 Jira 配置与 issue 存在）并为会话标题 / 任务消息提供摘要。
 */
export async function fetchJiraIssueSummary(settings: JiraSettings, key: string): Promise<Pick<JiraIssueDetail, 'key' | 'summary'>> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  const issue = await client.issues.getIssue({
    issueIdOrKey: key,
    fields: ['summary'],
  })
  return {
    key: issue.key ?? key,
    summary: issue.fields?.summary ?? '',
  }
}

/** 往指定 issue 添加一条评论（ADF 格式 body）。 */
export async function addJiraComment(settings: JiraSettings, key: string, text: string): Promise<void> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  await client.issueComments.addComment({
    issueIdOrKey: key,
    comment: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text }],
        },
      ],
    } as Document,
  })
}

/** 通过 JQL 搜索 issues。 */
export async function searchJiraIssues(settings: JiraSettings, jql: string): Promise<JiraTodo[]> {
  assertJiraSettings(settings)
  const baseUrl = jiraBaseUrl(settings)
  const client = createJiraClient(settings)
  const result = await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
    jql,
    fields: ['key', 'summary', 'issuetype', 'status'],
    maxResults: 50,
  })
  const issues = result.issues
  if (!Array.isArray(issues)) throw new Error('Jira API 返回结构异常（期望 issues 数组）')
  return issues.filter((issue) => typeof issue.key === 'string').map((issue) => {
    const fields = issue.fields
    const typeName = fields.issuetype?.name ?? fields.issueType?.name ?? 'Issue'
    return {
      key: issue.key,
      summary: fields.summary ?? '',
      typeName,
      typeColor: colorForIssueType(typeName),
      typeIconUrl: resolveIconUrl(baseUrl, fields.issuetype?.iconUrl ?? fields.issueType?.iconUrl ?? undefined),
      statusName: fields.status?.name ?? '',
    }
  })
}

/** 创建 Jira issue。 */
export async function createJiraIssue(
  settings: JiraSettings,
  { project, summary, description, issueType }: { project: string; summary: string; description?: string; issueType?: string },
): Promise<{ key: string }> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  const result = await client.issues.createIssue({
    fields: {
      project: { key: project },
      summary,
      issuetype: { name: issueType ?? 'Task' },
      description: description
        ? {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
          }
        : undefined,
    },
  })
  return { key: result.key }
}

/** 获取 issue 可执行的状态变更列表。 */
export async function getJiraTransitions(settings: JiraSettings, key: string): Promise<Array<{ id: string; name: string }>> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  const result = await client.issues.getTransitions({ issueIdOrKey: key })
  const transitions = result.transitions ?? []
  return transitions
    .filter((t) => typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => ({ id: t.id as string, name: t.name as string }))
}

/** 执行 issue 状态变更。 */
export async function transitionJiraIssue(settings: JiraSettings, key: string, transitionId: string): Promise<void> {
  assertJiraSettings(settings)
  const client = createJiraClient(settings)
  await client.issues.doTransition({
    issueIdOrKey: key,
    transition: { id: transitionId },
  })
}
