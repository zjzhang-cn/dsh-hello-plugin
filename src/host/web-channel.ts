/**
 * 自建 /hello web 通道：客户端 → 宿主的 RPC 承载。
 *
 * **为什么不用 `ctx.connection.rpc.handle`**：该 API 内部把通道注册到「服务实例持有的 ctx」
 * 的 `webServer` 上（client-connection/src/rpc-host.ts 的 `register()`：
 * `owner.effect(() => owner.webServer.register(route))`，而 `owner` 是构造
 * `HostConnectionService` 时传入的 connection 插件 ctx，它只 inject 了 `credentials`）——
 * 解析从 connection 插件的 fiber 出发，插件侧再怎么声明依赖都够不着，任何消费方调用都会抛
 * `cannot get property "webServer" without inject`（harness 侧缺陷，2026-09-10 定位；
 * dev profile 实测 `rpc.handle` 通道永远挂不上，POST 落到静态兜底返回 405）。
 *
 * 这里做等价自建（约 60 行）：
 * - 在**插件自己的 `ctx.webServer`** 上注册同前缀路由（`webServer` 已在插件顶层 inject）；
 * - 复用 connection 的信任/鉴权栅栏 `requestRejection`（Host/Origin 检查 + 浏览器 cookie），
 *   拒绝逻辑与 connection 自挂 `/api` 路由逐字一致；
 * - 沿用 Connection RPC 信封，客户端半区零改动（仍走
 *   `connection.rpc.call('/hello', endpoint, { args })`）：
 *     请求  POST `/hello/<endpoint>`，JSON `{ type:'client-request', rpcId, method, payload }`
 *     响应  200 JSON `{ type:'server-response', rpcId, result }`，result 为 `{ ok, value }` 或
 *           `{ ok: false, error }`。
 * 行为对齐 harness 的 `rpcFetchHandler` + `bridge`：非 POST / 非 JSON 内容类型 / 非法信封分别
 * 返回 404 / 415 / 400；客户端断开中止 handler（`AbortSignal`），长轮询因此在页面关闭时释放。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle,ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
// 类型副作用导入：该包对 cordis Context 做模块增强（ctx.webServer 的类型来源）
import type {} from '@deepseek-ai/dsh-host-webserver'
/** 通道前缀：客户端 `connection.rpc.call('/hello', …)` 与本文件的路由共用。 */
export const CHANNEL_PATH = '/hello'

/** 请求体上限（信封很小，1 MiB 足够；超出返回 413）。 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/** 端点段校验：与 harness `rpc-host.ts` 的 ENDPOINT_SEGMENT_PATTERN 保持一致。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** `requestRejection` 的参数类型（IncomingMessage 结构上满足，仅类型层转换）。 */
type TrustRequest = ConnectionTrustRequest

/** 客户端请求信封（Connection RPC 约定）。 */
interface ClientRequestEnvelope {
	type: 'client-request'
	rpcId: string
	method: string
	payload: unknown
}

/** 判断是否为合法的客户端请求信封。 */
function isClientRequestEnvelope(value: unknown): value is ClientRequestEnvelope {
	if (typeof value !== 'object' || value === null) return false
	const envelope = value as { type?: unknown; rpcId?: unknown; method?: unknown }
	return envelope.type === 'client-request'
		&& typeof envelope.rpcId === 'string'
		&& typeof envelope.method === 'string'
}

/** 从 `/hello/<endpoint>` 路径中取出端点（与 harness `endpointFromPath` 同规则）。 */
function endpointFromPath(pathname: string): string | undefined {
	if (!pathname.startsWith(`${CHANNEL_PATH}/`)) return undefined
	const endpoint = pathname.slice(CHANNEL_PATH.length + 1)
	const segments = endpoint.split('/')
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
		|| !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
		return undefined
	}
	return endpoint
}

/** 读满请求体（带上限），超限时按 bridge 的做法回 413 并断开。 */
async function readBody(req: IncomingMessage): Promise<string | null> {
	const chunks: Buffer[] = []
	let received = 0
	for await (const chunk of req) {
		const buffer = chunk as Buffer
		received += buffer.byteLength
		if (received > MAX_REQUEST_BODY_BYTES) return null
		chunks.push(buffer)
	}
	return Buffer.concat(chunks).toString('utf8')
}

/** 一个请求的完整处理：栅栏 → 校验 → 信封解析 → handler → 响应编码。 */
async function handleRequest(
	connection: HostConnectionHandle,
	handler: ConnectionRpcHandler,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	// 与 connection 自挂 /api 路由一致：先过 Host/Origin 信任与鉴权栅栏（403 / 401）
	const rejection = connection.requestRejection(req as ConnectionTrustRequest)
	if (rejection !== undefined) {
		res.writeHead(rejection)
		res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
		return
	}

	if (req.method !== 'POST') {
		res.writeHead(404)
		res.end('not found')
		return
	}
	const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
	if (mediaType !== 'application/json') {
		res.writeHead(415)
		res.end('content type must be application/json')
		return
	}

	const text = await readBody(req)
	if (text === null) {
		res.writeHead(413, { connection: 'close' })
		res.end()
		req.destroy()
		return
	}

	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		res.writeHead(400)
		res.end('body is not JSON')
		return
	}
	if (!isClientRequestEnvelope(body)) {
		res.writeHead(400)
		res.end('body is not a client-request envelope')
		return
	}

	const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
	const endpoint = endpointFromPath(pathname)
	if (endpoint === undefined || endpoint !== body.method) {
		res.writeHead(404)
		res.end('not found')
		return
	}

	// 客户端断开（响应未正常结束时的 close）→ 中止 handler，与 bridge 的语义一致
	const abort = new AbortController()
	res.on('close', () => {
		if (!res.writableEnded) abort.abort()
	})

	let result: unknown
	try {
		result = await handler(endpoint, body.payload, abort.signal)
	} catch (error) {
		res.writeHead(500)
		res.end(`handler failure: ${String(error)}`)
		return
	}

	const payload = JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result })
	res.writeHead(200, { 'content-type': 'application/json' })
	res.end(payload)
}

/**
 * 把 handler 挂到插件自己的 webServer 上（`<channel>` 前缀路由）。
 * 注册包在 `ctx.effect` 内，插件卸载时路由随之撤销。
 */
export function mountHelloChannel(ctx: Context, handler: ConnectionRpcHandler): void {
	// 服务在 apply 期间读取一次：register 的回调与请求处理都复用它
	const connection = ctx.connection
	// 挂载路由
	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: CHANNEL_PATH,
		handler: (req, res) => handleRequest(connection, handler, req, res),
	}), `hello-plugin: ${CHANNEL_PATH} rpc channel`)
}
