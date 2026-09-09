import type { Context } from '@deepseek-ai/cordis'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GoogleNewsItem } from './types'

/** 直连（无代理）fetch 超时，与改动前一致。 */
const DIRECT_TIMEOUT_MS = 10_000
/** 代理链路单步（TCP 连接 / CONNECT / TLS 握手 / 读取）超时。 */
const PROXY_TIMEOUT_MS = 15_000
/** 代理路径手动跟随重定向的最大次数。 */
const MAX_REDIRECTS = 5

/** 手写 HTTP 解析出的原始响应（代理路径不使用全局 fetch 的 Response）。 */
interface RawResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

/** 目标协议 → 代理环境变量（大写优先，兼容小写，curl 语义）。 */
const PROXY_ENV_KEYS: Record<'http' | 'https', string[]> = {
  http: ['HTTP_PROXY', 'http_proxy'],
  https: ['HTTPS_PROXY', 'https_proxy'],
}
const ALL_PROXY_ENV_KEYS = ['ALL_PROXY', 'all_proxy'] as const

/**
 * 解析目标 URL 应走的代理：先查协议专用变量（HTTPS_PROXY / HTTP_PROXY），
 * 再查 ALL_PROXY；目标命中 NO_PROXY 或环境未配置代理时返回 undefined（直连）。
 */
function resolveProxy(target: URL): URL | undefined {
  const scheme = target.protocol === 'https:' ? 'https' : target.protocol === 'http:' ? 'http' : null
  if (scheme === null || noProxyMatches(target)) return undefined
  for (const key of [...PROXY_ENV_KEYS[scheme], ...ALL_PROXY_ENV_KEYS]) {
    const value = process.env[key]
    if (value === undefined || value.trim() === '') continue
    try {
      return new URL(value.trim())
    } catch {
      // 非法代理地址按未配置处理，回退直连
    }
  }
  return undefined
}

/** NO_PROXY 判定：支持 `*`、精确主机名、`.后缀`/`后缀`（子域匹配）、`host:port`。 */
function noProxyMatches(target: URL): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy
  if (raw === undefined) return false
  const host = target.hostname.toLowerCase()
  const port = target.port !== '' ? target.port : (target.protocol === 'https:' ? '443' : '80')
  for (const entry of raw.split(',')) {
    const item = entry.trim().toLowerCase()
    if (item === '') continue
    if (item === '*') return true
    const bare = item.startsWith('.') ? item.slice(1) : item
    const colon = bare.lastIndexOf(':')
    if (colon !== -1) {
      const itemHost = bare.slice(0, colon)
      const itemPort = bare.slice(colon + 1)
      if ((itemHost === '*' || itemHost === host) && itemPort === port) return true
      continue
    }
    if (host === bare || host.endsWith('.' + bare)) return true
  }
  return false
}

/**
 * 带代理能力的 GET：环境无代理时走全局 fetch（自动跟随重定向）；有代理时经
 * 代理链路（https 目标走 CONNECT 隧道，http 目标走绝对 URI 形式），并手动
 * 跟随重定向。返回最终响应的状态、头与文本。
 */
async function fetchWithProxy(url: string, redirects = 0): Promise<RawResponse> {
  const target = new URL(url)
  if (redirects > MAX_REDIRECTS) throw new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）`)
  const proxy = resolveProxy(target)
  if (proxy === undefined) {
    const response = await fetch(url, { signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) })
    return { status: response.status, statusText: response.statusText, headers: {}, body: await response.text() }
  }
  let raw: RawResponse
  if (target.protocol === 'https:') {
    raw = await httpsViaTunnel(proxy, target)
  } else if (target.protocol === 'http:') {
    raw = await httpViaAbsoluteForm(proxy, target)
  } else {
    throw new Error(`不支持的协议：${target.protocol}`)
  }
  const location = raw.headers['location']
  if (raw.status >= 300 && raw.status < 400 && location !== undefined && location !== '') {
    return fetchWithProxy(new URL(location, target).toString(), redirects + 1)
  }
  return raw
}

/** 建立到 host:port 的 TCP 连接（带超时与错误处理）。 */
function connectRaw(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port })
    socket.setTimeout(PROXY_TIMEOUT_MS, () => socket.destroy(new Error(`连接 ${host}:${port} 超时`)))
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.setTimeout(0)
      socket.off('error', reject)
      resolve(socket)
    })
  })
}

/** 在已连接 socket 上包一层 TLS（用于 https 代理，或隧道内的 https 目标）。 */
function wrapTls(socket: Socket, servername: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername })
    tlsSocket.setTimeout(PROXY_TIMEOUT_MS, () => tlsSocket.destroy(new Error(`TLS 握手 ${servername} 超时`)))
    tlsSocket.once('error', reject)
    tlsSocket.once('secureConnect', () => {
      tlsSocket.setTimeout(0)
      tlsSocket.off('error', reject)
      resolve(tlsSocket)
    })
  })
}

/** 代理 URL 的 Basic 认证头（无凭据时返回 undefined）。 */
function proxyAuthorization(proxy: URL): string | undefined {
  if (proxy.username === '') return undefined
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password ?? '')}`
  return 'Basic ' + Buffer.from(credentials).toString('base64')
}

/** 打开到目标的 CONNECT 隧道（支持 http / https 代理，含 Basic 认证）。 */
async function openTunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  const proxyPort = proxy.port !== '' ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80
  let socket = await connectRaw(proxy.hostname, proxyPort)
  if (proxy.protocol === 'https:') socket = await wrapTls(socket, proxy.hostname)
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    'Proxy-Connection: keep-alive',
  ]
  const auth = proxyAuthorization(proxy)
  if (auth !== undefined) lines.push(`Proxy-Authorization: ${auth}`)
  const headPromise = readUntilHead(socket)
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  const head = await headPromise
  if (head.status < 200 || head.status >= 300) {
    socket.destroy()
    throw new Error(`代理 CONNECT 失败：${head.status} ${head.statusText}`)
  }
  return socket
}

/** 读取到第一个 `\r\n\r\n`，解析状态行与头（用于 CONNECT 应答）。 */
function readUntilHead(socket: Socket): Promise<{ status: number; statusText: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return
      cleanup()
      const lines = buffer.slice(0, idx).split('\r\n')
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status: match ? Number(match[1]) : 0, statusText: match?.[2] ?? '', headers })
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onTimeout = (): void => {
      socket.destroy(new Error('读取响应头超时'))
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      socket.setTimeout(0)
    }
    socket.setTimeout(PROXY_TIMEOUT_MS, onTimeout)
    socket.on('data', onData)
    socket.once('error', onError)
  })
}

/** 读取完整响应体（Content-Length 已知时提前结束，否则等待连接关闭），统一解析。 */
function readResponse(socket: Socket): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let head: { status: number; statusText: string; headers: Record<string, string>; bodyStart: number } | null = null

    const finish = (): void => {
      cleanup()
      resolve(parseResponse(Buffer.concat(chunks, total)))
    }
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk)
      total += chunk.length
      if (head === null) head = tryParseHead()
      if (head !== null && bodyComplete(head)) finish()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onTimeout = (): void => {
      socket.destroy(new Error('读取响应超时'))
    }
    const onEnd = (): void => {
      finish()
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      socket.off('end', onEnd)
      socket.setTimeout(0)
    }
    const tryParseHead = (): { status: number; statusText: string; headers: Record<string, string>; bodyStart: number } | null => {
      const data = Buffer.concat(chunks, total)
      const sep = data.indexOf('\r\n\r\n')
      if (sep === -1) return null
      const lines = data.toString('utf8', 0, sep).split('\r\n')
      const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
      if (!match) return null
      const headers: Record<string, string> = {}
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon === -1) continue
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
      }
      return { status: Number(match[1] ?? 0), statusText: match[2] ?? '', headers, bodyStart: sep + 4 }
    }
    const bodyComplete = (parsed: { headers: Record<string, string>; bodyStart: number }): boolean => {
      if ((parsed.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) return false
      const contentLength = Number(parsed.headers['content-length'] ?? NaN)
      if (!Number.isNaN(contentLength)) return total - parsed.bodyStart >= contentLength
      return false
    }

    socket.setTimeout(PROXY_TIMEOUT_MS, onTimeout)
    socket.on('data', onData)
    socket.once('end', onEnd)
    socket.once('error', onError)
  })
}

/** 从完整响应字节解析状态 / 头 / 文本（含 chunked 解码）。 */
function parseResponse(raw: Buffer): RawResponse {
  const text = raw.toString('utf8')
  const sep = text.indexOf('\r\n\r\n')
  if (sep === -1) throw new Error('响应缺少 HTTP 头部')
  const lines = text.slice(0, sep).split('\r\n')
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0] ?? '')
  if (!match) throw new Error(`无法解析响应状态行：${lines[0] ?? ''}`)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  let body = text.slice(sep + 4)
  if ((headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = decodeChunked(body)
  return { status: Number(match[1] ?? 0), statusText: match[2] ?? '', headers, body }
}

/** 简易 chunked 解码（HTTP/1.1 分块传输）。 */
function decodeChunked(text: string): string {
  let result = ''
  let rest = text
  for (;;) {
    const lineEnd = rest.indexOf('\r\n')
    if (lineEnd === -1) break
    const sizeText = (rest.slice(0, lineEnd).split(';')[0] ?? '').trim()
    const size = parseInt(sizeText, 16)
    rest = rest.slice(lineEnd + 2)
    if (Number.isNaN(size) || size < 0) break
    if (size === 0) break
    if (rest.length < size) break
    result += rest.slice(0, size)
    rest = rest.slice(size)
    if (rest.startsWith('\r\n')) rest = rest.slice(2)
  }
  return result
}

/** 生成 HTTP/1.1 GET 请求文本（absoluteForm 用于 http 目标经代理的绝对 URI 形式）。 */
function buildRequest(target: URL, absoluteForm: boolean, auth: string | undefined): string {
  const lines = [
    `GET ${absoluteForm ? target.href : target.pathname + target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Accept: */*',
    'User-Agent: dsh-hello-plugin/0.1',
    'Connection: close',
  ]
  if (auth !== undefined) lines.push(`Proxy-Authorization: ${auth}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/** https 目标：CONNECT 隧道 + TLS + GET。 */
async function httpsViaTunnel(proxy: URL, target: URL): Promise<RawResponse> {
  const port = target.port !== '' ? Number(target.port) : 443
  const tunnel = await openTunnel(proxy, target.hostname, port)
  const socket = await wrapTls(tunnel, target.hostname)
  try {
    const responsePromise = readResponse(socket)
    socket.write(buildRequest(target, false, undefined))
    return await responsePromise
  } finally {
    socket.destroy()
  }
}

/** http 目标：向代理发送绝对 URI 形式请求（无需隧道）。 */
async function httpViaAbsoluteForm(proxy: URL, target: URL): Promise<RawResponse> {
  const proxyPort = proxy.port !== '' ? Number(proxy.port) : 80
  let socket = await connectRaw(proxy.hostname, proxyPort)
  if (proxy.protocol === 'https:') socket = await wrapTls(socket, proxy.hostname)
  try {
    const responsePromise = readResponse(socket)
    socket.write(buildRequest(target, true, proxyAuthorization(proxy)))
    return await responsePromise
  } finally {
    socket.destroy()
  }
}

/**
 * 抓取 Google News RSS 并解析为新闻列表（标题 + 链接 + 发布时间）。
 * 优先走 Node 全局 fetch；若环境配置了 HTTP(S)_PROXY / ALL_PROXY 且目标不在
 * NO_PROXY 内，则经代理链路抓取（https 目标走 CONNECT 隧道）。代理链路全部用
 * Node 内建模块实现（node:net / node:tls），不引入额外运行时依赖。
 */
export async function fetchGoogleNews(locale: string): Promise<GoogleNewsItem[]> {
  const region = locale.toUpperCase()
  const url = `https://news.google.com/rss?hl=${locale}&gl=${region}&ceid=${region}:${locale}`
  const response = await fetchWithProxy(url)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Google News ${response.status} ${response.statusText}`)
  }
  const items: GoogleNewsItem[] = []
  const itemPattern = /<item>([\s\S]*?)<\/item>/g
  for (const match of response.body.matchAll(itemPattern)) {
    const block = match[1] ?? ''
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? ''
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) ?? [])[1] ?? ''
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ?? [])[1] ?? ''
    if (title !== '') items.push({ title, link, pubDate })
  }
  return items.slice(0, 15)
}

/**
 * 在 Agent 作用域内注册 google_news 工具。
 * 从 agentCtx 调用 ctx.tools.register（官方 dsh-tools 的 ToolDefinition 类型），
 * 走 ScopedLayers —— 仅该会话的 Agent 可见，不污染全局工具表。
 */
export function installGoogleNewsTool(agentCtx: Context): void {
  const def: ToolDefinition = {
    name: 'google_news',
    description: '获取 Google News 最新新闻列表（标题 + 链接 + 发布时间）。用于了解当前热点新闻。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locale: { type: 'string', description: '语言地区，如 zh-CN 或 en-US' },
      },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' }, link: { type: 'string' }, pubDate: { type: 'string' },
          },
        },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: unknown) {
      const raw = (args as { locale?: unknown } | undefined)?.locale
      const locale = typeof raw === 'string' && raw !== '' ? raw : 'zh-CN'
      return fetchGoogleNews(locale)
    },
  }
  agentCtx.tools.register(def)
}
