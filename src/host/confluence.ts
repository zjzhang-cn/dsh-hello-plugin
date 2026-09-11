import { createV1Client, createV2Client } from 'confluence.js'
import { ConfluenceConfigError } from './errors'
import type { ConfluenceSettings } from './types'

/**
 * Confluence API 工具（confluence.js 3.x）。
 *
 * 与 jira.js 的两点差异：
 * - 工厂是 createV1Client / createV2Client，配置形如 { host, auth: { type: 'basic', email, apiToken } }；
 * - v2 的 create/update 把参数里的 `body` **原样透传**为请求体（本模块负责组装完整 payload），
 *   CQL 搜索只在 v1（client.search.searchByCQL），因此同时持有 v1/v2 两个客户端。
 *
 * 正文统一用 storage 格式（XHTML 子集）收发，对模型只暴露纯文本（读时转文本、写时包 <p>）；
 * 模型可见输出一律做存在性收窄（返回字段全部可选，缺失给空串/0，不抛解析错）。
 */

/** 断言并解析连接配置（缺项 → ConfluenceConfigError，工具结果给模型可读原因）。 */
function resolveConfig(settings: ConfluenceSettings): {
  host: string
  baseUrl: string
  auth: { type: 'basic'; email: string; apiToken: string }
} {
  if (settings.baseUrl === undefined || settings.baseUrl.trim() === '') throw new ConfluenceConfigError('confluence.baseUrl 未配置')
  if (settings.email === undefined || settings.email.trim() === '') throw new ConfluenceConfigError('confluence.email 未配置')
  if (settings.apiToken === undefined || settings.apiToken.trim() === '') throw new ConfluenceConfigError('confluence.apiToken 未配置')
  // 归一化为裸站点地址：confluence.js 自己带 /wiki 前缀发请求，填成 https://site.atlassian.net/wiki 会重复
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '').replace(/\/wiki$/, '')
  return {
    host: baseUrl,
    baseUrl,
    auth: { type: 'basic', email: settings.email, apiToken: settings.apiToken },
  }
}

/** 创建 v1/v2 一对客户端（同一站点与凭据；v1 出 CQL 搜索，v2 出页面/空间/评论）。 */
function createClients(settings: ConfluenceSettings): {
  v1: ReturnType<typeof createV1Client>
  v2: ReturnType<typeof createV2Client>
  baseUrl: string
} {
  const config = resolveConfig(settings)
  return {
    v1: createV1Client({ host: config.host, auth: config.auth }),
    v2: createV2Client({ host: config.host, auth: config.auth }),
    baseUrl: config.baseUrl,
  }
}

/** storage 格式 → 纯文本：换行语义的标签转 \n，其余标签剥掉，再解实体、压缩空行。 */
function storageToText(storage: string): string {
  return storage
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 纯文本 → storage：转义 HTML，空行分段包 <p>，段内换行转 <br/>。 */
function textToStorage(text: string): string {
  const escape = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, '<br/>')}</p>`)
    .join('')
}

/** 拼接页面链接：优先用 API 返回的 _links.webui，缺失则退回 /wiki/pages/{id}。 */
function pageWebUrl(baseUrl: string, id: string, links: unknown): string {
  const webui = (links as { webui?: unknown } | undefined)?.webui
  if (typeof webui === 'string' && webui !== '') {
    return baseUrl + '/wiki' + (webui.startsWith('/') ? webui : '/' + webui)
  }
  return `${baseUrl}/wiki/pages/${id}`
}

/** 搜索结果的 url/relative path 拼成完整链接（已是绝对地址则原样返回）。 */
function absoluteUrl(baseUrl: string, url: string): string {
  if (url === '') return ''
  if (/^https?:\/\//i.test(url)) return url
  return baseUrl + (url.startsWith('/') ? url : '/' + url)
}

/** 校验数字形态的 id（v2 的 page/space id 在请求参数里是 number）。 */
function numericId(raw: string, label: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} 必须是数字 id：${raw}`)
  return value
}

/** 一条 CQL 搜索结果（已转纯文本摘要 + 完整链接）。 */
export interface ConfluenceSearchItem {
  id: string
  title: string
  type: string
  spaceKey: string
  excerpt: string
  url: string
}

/** CQL 搜索页面/博客（v1 search API）。 */
export async function searchConfluence(
  settings: ConfluenceSettings,
  options: { cql: string; limit?: number },
): Promise<ConfluenceSearchItem[]> {
  const { v1, baseUrl } = createClients(settings)
  const result = await v1.search.searchByCQL({
    cql: options.cql,
    limit: options.limit ?? 10,
    excerpt: 'highlight',
  })
  const base = typeof result._links?.base === 'string' && result._links.base !== ''
    ? result._links.base.replace(/\/+$/, '')
    : baseUrl + '/wiki'
  return (Array.isArray(result.results) ? result.results : []).map((item) => ({
    id: typeof item.content?.id === 'string' ? item.content.id : '',
    title: item.title ?? '',
    type: typeof item.content?.type === 'string' ? item.content.type : (item.entityType ?? ''),
    spaceKey: typeof item.space?.key === 'string' ? item.space.key : '',
    excerpt: storageToText(item.excerpt ?? '').replace(/\s+/g, ' ').trim(),
    url: absoluteUrl(base, item.url ?? ''),
  }))
}

/** 单个页面详情（正文已转纯文本）。 */
export interface ConfluencePageDetail {
  id: string
  title: string
  spaceId: string
  version: number
  url: string
  bodyText: string
}

/** 按 id 读取页面（bodyFormat: storage）。 */
export async function getConfluencePage(
  settings: ConfluenceSettings,
  id: string,
): Promise<ConfluencePageDetail> {
  const { v2, baseUrl } = createClients(settings)
  const page = await v2.page.getPageById({ id: numericId(id, 'pageId'), bodyFormat: 'storage' })
  const pageId = typeof page.id === 'string' && page.id !== '' ? page.id : id
  return {
    id: pageId,
    title: page.title ?? '',
    spaceId: page.spaceId ?? '',
    version: page.version?.number ?? 0,
    url: pageWebUrl(baseUrl, pageId, page._links),
    bodyText: storageToText(page.body?.storage?.value ?? ''),
  }
}

/** 列空间（key 可用于 CQL `space = "KEY"` 与后续查询）。 */
export async function listConfluenceSpaces(
  settings: ConfluenceSettings,
  options: { limit?: number } = {},
): Promise<Array<{ id: string; key: string; name: string }>> {
  const { v2 } = createClients(settings)
  const spaces = await v2.space.getSpaces({ limit: options.limit ?? 25 })
  return (Array.isArray(spaces.results) ? spaces.results : []).map((space) => ({
    id: space.id ?? '',
    key: space.key ?? '',
    name: space.name ?? '',
  }))
}

/** 空间内页面列表（可按标题过滤）。 */
export async function listConfluencePages(
  settings: ConfluenceSettings,
  options: { spaceId: string; limit?: number; title?: string },
): Promise<Array<{ id: string; title: string; version: number; url: string }>> {
  const { v2, baseUrl } = createClients(settings)
  const pages = await v2.page.getPagesInSpace({
    id: numericId(options.spaceId, 'spaceId'),
    limit: options.limit ?? 25,
    ...(options.title !== undefined && options.title !== '' ? { title: options.title } : {}),
  })
  return (Array.isArray(pages.results) ? pages.results : []).map((page) => {
    const pageId = page.id ?? ''
    return {
      id: pageId,
      title: page.title ?? '',
      version: page.version?.number ?? 0,
      url: pageWebUrl(baseUrl, pageId, page._links),
    }
  })
}

/** 在空间下创建页面（storage 正文，status: current）。 */
export async function createConfluencePage(
  settings: ConfluenceSettings,
  options: { spaceId: string; title: string; bodyText: string },
): Promise<{ id: string; title: string; url: string }> {
  const { v2, baseUrl } = createClients(settings)
  const page = await v2.page.createPage({
    body: {
      spaceId: options.spaceId,
      status: 'current',
      title: options.title,
      body: { representation: 'storage', value: textToStorage(options.bodyText) },
    },
  })
  const pageId = page.id ?? ''
  return { id: pageId, title: page.title ?? options.title, url: pageWebUrl(baseUrl, pageId, page._links) }
}

/** 更新页面：先读当前标题与版本号，写回时 version.number + 1（Confluence 的乐观锁要求）。 */
export async function updateConfluencePage(
  settings: ConfluenceSettings,
  options: { id: string; title?: string; bodyText: string },
): Promise<{ id: string; title: string; version: number; url: string }> {
  const { v2, baseUrl } = createClients(settings)
  const pageNumericId = numericId(options.id, 'pageId')
  const current = await v2.page.getPageById({ id: pageNumericId })
  const pageId = current.id ?? options.id
  const title = options.title !== undefined && options.title !== '' ? options.title : (current.title ?? '')
  const nextVersion = (current.version?.number ?? 0) + 1
  const page = await v2.page.updatePage({
    id: pageNumericId,
    body: {
      id: pageId,
      status: 'current',
      title,
      body: { representation: 'storage', value: textToStorage(options.bodyText) },
      version: { number: nextVersion },
    },
  })
  return {
    id: page.id ?? pageId,
    title: page.title ?? title,
    version: page.version?.number ?? nextVersion,
    url: pageWebUrl(baseUrl, pageId, page._links),
  }
}

/** 给页面添加底部评论（footer comment，storage 正文）。 */
export async function addConfluenceComment(
  settings: ConfluenceSettings,
  options: { pageId: string; text: string },
): Promise<{ pageId: string; commentId: string }> {
  const { v2 } = createClients(settings)
  const comment = await v2.comment.createFooterComment({
    pageId: options.pageId,
    body: { representation: 'storage', value: textToStorage(options.text) },
  })
  return { pageId: options.pageId, commentId: comment.id ?? '' }
}
