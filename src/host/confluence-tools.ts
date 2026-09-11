import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ConfluenceSettings } from './types'
import {
	searchConfluence,
	getConfluencePage,
	listConfluenceSpaces,
	listConfluencePages,
	createConfluencePage,
	updateConfluencePage,
	addConfluenceComment,
} from './confluence'

function stringArg(args: unknown, key: string): string {
	const value = (args as Record<string, unknown> | undefined)?.[key]
	return typeof value === 'string' ? value.trim() : ''
}

function numberArg(args: unknown, key: string): number | undefined {
	const value = (args as Record<string, unknown> | undefined)?.[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 注册 7 个 Confluence 工具为全局工具（ctx.tools，官方 dsh-tools 的 ToolDefinition 类型）。
 * 与 jira-tools 同构：4 个读工具（搜索 / 读页面 / 列空间 / 列空间内页面）+ 3 个写工具
 * （创建 / 更新页面、加评论）；配置缺失时执行结果返回 confluence-not-configured 文案。
 */
export function registerConfluenceTools(ctx: Context, resolveSettings: () => ConfluenceSettings): void {
	const defs: ToolDefinition[] = [
		{
			name: 'confluence_search',
			description: '用 CQL 搜索 Confluence 内容。CQL 示例：`siteSearch ~ "部署"`、`space = "DOC" AND type = page`、`title ~ "手册"`。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					cql: { type: 'string', description: 'CQL 查询语句' },
					limit: { type: 'number', description: '返回条数上限（默认 10）' },
				},
				required: ['cql'],
			},
			output: {
				schema: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: { type: 'string' },
							title: { type: 'string' },
							type: { type: 'string' },
							spaceKey: { type: 'string' },
							excerpt: { type: 'string' },
							url: { type: 'string' },
						},
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				const cql = stringArg(args, 'cql')
				return searchConfluence(resolveSettings(), { cql, limit: numberArg(args, 'limit') })
			},
		},
		{
			name: 'confluence_get_page',
			description: '按 id 读取 Confluence 页面：标题、版本、链接与正文（已转为纯文本）。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', description: '页面 id（数字）' },
				},
				required: ['id'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string' },
						title: { type: 'string' },
						spaceId: { type: 'string' },
						version: { type: 'number' },
						url: { type: 'string' },
						bodyText: { type: 'string' },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return getConfluencePage(resolveSettings(), stringArg(args, 'id'))
			},
		},
		{
			name: 'confluence_list_spaces',
			description: '列出 Confluence 空间（id / key / 名称）。key 可用于 CQL（如 space = "KEY"）与后续页面查询。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					limit: { type: 'number', description: '返回条数上限（默认 25）' },
				},
			},
			output: {
				schema: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: { type: 'string' },
							key: { type: 'string' },
							name: { type: 'string' },
						},
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return listConfluenceSpaces(resolveSettings(), { limit: numberArg(args, 'limit') })
			},
		},
		{
			name: 'confluence_list_pages',
			description: '列出某个 Confluence 空间内的页面（可用 title 精确过滤）。spaceId 可用 confluence_list_spaces 获取。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					spaceId: { type: 'string', description: '空间 id（数字）' },
					limit: { type: 'number', description: '返回条数上限（默认 25）' },
					title: { type: 'string', description: '按标题精确过滤（可选）' },
				},
				required: ['spaceId'],
			},
			output: {
				schema: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							id: { type: 'string' },
							title: { type: 'string' },
							version: { type: 'number' },
							url: { type: 'string' },
						},
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return listConfluencePages(resolveSettings(), {
					spaceId: stringArg(args, 'spaceId'),
					limit: numberArg(args, 'limit'),
					title: stringArg(args, 'title'),
				})
			},
		},
		{
			name: 'confluence_create_page',
			description: '在指定空间下创建 Confluence 页面。bodyText 为纯文本（空行分段，写入时转为 storage 格式）。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					spaceId: { type: 'string', description: '空间 id（数字）' },
					title: { type: 'string', description: '页面标题' },
					bodyText: { type: 'string', description: '页面正文（纯文本）' },
				},
				required: ['spaceId', 'title', 'bodyText'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string' },
						title: { type: 'string' },
						url: { type: 'string' },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return createConfluencePage(resolveSettings(), {
					spaceId: stringArg(args, 'spaceId'),
					title: stringArg(args, 'title'),
					bodyText: stringArg(args, 'bodyText'),
				})
			},
		},
		{
			name: 'confluence_update_page',
			description: '更新 Confluence 页面正文（可选改标题）。自动读取当前版本号并 +1 写回，无需调用方处理版本。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					id: { type: 'string', description: '页面 id（数字）' },
					title: { type: 'string', description: '新标题（可选，缺省保持原标题）' },
					bodyText: { type: 'string', description: '新正文（纯文本，整体替换）' },
				},
				required: ['id', 'bodyText'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string' },
						title: { type: 'string' },
						version: { type: 'number' },
						url: { type: 'string' },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return updateConfluencePage(resolveSettings(), {
					id: stringArg(args, 'id'),
					title: stringArg(args, 'title'),
					bodyText: stringArg(args, 'bodyText'),
				})
			},
		},
		{
			name: 'confluence_add_comment',
			description: '给 Confluence 页面添加一条底部评论（footer comment，纯文本）。',
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					pageId: { type: 'string', description: '页面 id' },
					text: { type: 'string', description: '评论内容（纯文本）' },
				},
				required: ['pageId', 'text'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						pageId: { type: 'string' },
						commentId: { type: 'string' },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
			},
			async execute(args: unknown) {
				return addConfluenceComment(resolveSettings(), {
					pageId: stringArg(args, 'pageId'),
					text: stringArg(args, 'text'),
				})
			},
		},
	]

	for (const def of defs) {
		ctx.tools.register(def)
	}
}
