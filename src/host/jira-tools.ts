import type { Context } from '@deepseek-ai/cordis'
import type { JiraSettings } from './types'
import {
  searchJiraIssues,
  fetchJiraIssueDetail,
  createJiraIssue,
  addJiraComment,
  getJiraTransitions,
  transitionJiraIssue,
} from './jira'

interface ToolRegistry {
  register(definition: object): () => void
}

function jiraToolRegistry(ctx: Context): ToolRegistry {
  return (ctx as unknown as { tools: ToolRegistry }).tools
}

export function registerJiraTools(ctx: Context, resolveSettings: () => JiraSettings): void {
  const registry = jiraToolRegistry(ctx)

  registry.register({
    name: 'jira_search_issues',
    description: '通过 JQL 查询 Jira issues。支持任意 JQL 语法，如 "project = MYPROJ AND status = Open"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        jql: { type: 'string', description: 'JQL 查询语句' },
      },
      required: ['jql'],
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            key: { type: 'string' },
            summary: { type: 'string' },
            typeName: { type: 'string' },
            typeColor: { type: 'string' },
            typeIconUrl: { type: 'string' },
            statusName: { type: 'string' },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const jql = typeof (args as { jql?: unknown }).jql === 'string' ? (args as { jql: string }).jql : ''
      return searchJiraIssues(resolveSettings(), jql)
    },
  })

  registry.register({
    name: 'jira_get_issue',
    description: '获取单个 Jira issue 的详情，包括 summary、description、comments。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Issue key，如 MYPROJ-123' },
      },
      required: ['key'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          summary: { type: 'string' },
          descriptionText: { type: 'string' },
          commentsText: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const key = typeof (args as { key?: unknown }).key === 'string' ? (args as { key: string }).key : ''
      return fetchJiraIssueDetail(resolveSettings(), key)
    },
  })

  registry.register({
    name: 'jira_create_issue',
    description: '在 Jira 中创建一个新 issue。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: '项目 key，如 MYPROJ' },
        summary: { type: 'string', description: 'Issue 标题' },
        description: { type: 'string', description: 'Issue 描述（可选）' },
        issueType: { type: 'string', description: 'Issue 类型，如 Task、Bug、Story（默认 Task）' },
      },
      required: ['project', 'summary'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const a = args as { project?: string; summary?: string; description?: string; issueType?: string }
      return createJiraIssue(resolveSettings(), {
        project: a.project ?? '',
        summary: a.summary ?? '',
        description: a.description,
        issueType: a.issueType,
      })
    },
  })

  registry.register({
    name: 'jira_add_comment',
    description: '往指定 Jira issue 添加一条评论。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Issue key，如 MYPROJ-123' },
        text: { type: 'string', description: '评论内容' },
      },
      required: ['key', 'text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const a = args as { key?: string; text?: string }
      await addJiraComment(resolveSettings(), a.key ?? '', a.text ?? '')
      return { added: true }
    },
  })

  registry.register({
    name: 'jira_update_status',
    description: '更新 Jira issue 的状态（执行 transition）。先获取可用 transitions，再执行变更。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Issue key，如 MYPROJ-123' },
        transitionId: { type: 'string', description: 'Transition ID（可通过 jira_get_transitions 获取）' },
      },
      required: ['key', 'transitionId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean' },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const a = args as { key?: string; transitionId?: string }
      await transitionJiraIssue(resolveSettings(), a.key ?? '', a.transitionId ?? '')
      return { success: true }
    },
  })

  registry.register({
    name: 'jira_get_transitions',
    description: '获取某个 Jira issue 当前可执行的状态变更列表（transition id + name）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Issue key，如 MYPROJ-123' },
      },
      required: ['key'],
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const key = typeof (args as { key?: unknown }).key === 'string' ? (args as { key: string }).key : ''
      return getJiraTransitions(resolveSettings(), key)
    },
  })
}
