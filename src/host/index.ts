import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { } from '@deepseek-ai/dsh-session-title'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { name, inject, POLL_TIMEOUT_MS } from './constants'
import { loadProjectJiraConfig, loadProjectConfluenceConfig, loadProjectLlmConfig } from './config'
import { fetchJiraTodos, fetchJiraIssueSummary, addJiraComment } from './jira'
import { registerJiraTools } from './jira-tools'
import { runJiraAnalysisSession } from './jira-agent'
import { registerConfluenceTools } from './confluence-tools'
import { installGoogleNewsTool } from './news'
import { mountHelloChannel } from './web-channel'
import { JiraConfigError, rpcFailure } from './errors'
import type { PendingEvent, JiraSettings, ConfluenceSettings, LlmConfig, NewsStatus } from './types'

export { name, inject }
export type { JiraTodo, JiraSettings } from './types'

export function apply(ctx: Context): void {
	const logger = ctx.logger('hello-plugin')
	logger.info('host loaded')
	console.log('hello-plugin/host.js loaded')

	// ---- Jira 配置：工程根 jira.config.json 优先，其次 ctx.settings ----
	const projectConfig = loadProjectJiraConfig(logger)
	const settingsService = ctx.get('settings')
	let settingsJira: JiraSettings = {}
	if (settingsService !== undefined) {
		const scope = settingsService.register('jira', z.object({
			baseUrl: z.string().required(false),
			email: z.string().required(false),
			apiToken: z.string().required(false),
		}))
		settingsJira = scope.get()
		scope.watch(() => { settingsJira = scope.get() })
	} else if (projectConfig === null) {
		logger.warn('settings 服务不可用且无 jira.config.json，jira/todos 端点将返回未配置')
	}
	const resolveJiraSettings = (): JiraSettings => projectConfig ?? settingsJira

	// ---- Confluence 配置：工程根 confluence.config.json 优先，其次 ctx.settings（同 jira 模式）----
	const projectConfluenceConfig = loadProjectConfluenceConfig(logger)
	let settingsConfluence: ConfluenceSettings = {}
	if (settingsService !== undefined) {
		const scope = settingsService.register('confluence', z.object({
			baseUrl: z.string().required(false),
			email: z.string().required(false),
			apiToken: z.string().required(false),
		}))
		settingsConfluence = scope.get()
		scope.watch(() => { settingsConfluence = scope.get() })
	} else if (projectConfluenceConfig === null) {
		logger.warn('settings 服务不可用且无 confluence.config.json，confluence_* 工具将返回未配置')
	}
	const resolveConfluenceSettings = (): ConfluenceSettings => projectConfluenceConfig ?? settingsConfluence

	// ---- LLM 配置：工程根 llm.config.json（provider / model）----
	const llmConfig = loadProjectLlmConfig(logger) ?? {}
	if (llmConfig.provider === undefined || llmConfig.model === undefined) {
		logger.warn('llm.config.json 未配置或缺失，jira/analyze 端点将返回错误')
	}

	// ---- 宿主 → 客户端 的事件队列（长轮询）----
	const pending: PendingEvent[] = []
	const waiters: Array<{ resolve: (value: PendingEvent[] | null) => void; timer: NodeJS.Timeout }> = []

	// 最近一次新闻会话的状态。事件（news/done / news/failed）可能因页面刷新、
	// 长轮询请求中断等原因丢失，客户端在禁用按钮期间用 /agent/status 兜底核对，
	// 因此这里维护一份权威状态（只保留最近一条，UI 也只展示最近一次）。
	let latestNews: NewsStatus | null = null

	// ---- 宿主向客户端发送事件,将消息添加到待处理队列 ----
	function emit(event: string, args: unknown[] = []): void {
		// 将事件添加到待处理队列中
		pending.push({ event, args })
		logger.info('emit:', event, ...args)
		// 如果有等待的客户端，立即将事件发送给它们
		if (waiters.length > 0) {
			const snapshot = pending.splice(0)
			while (waiters.length > 0) {
				const w = waiters.shift()
				if (w === undefined) break
				clearTimeout(w.timer)
				w.resolve(snapshot)
			}
		}
	}

	// ---- 注册 Jira / Confluence 全局工具 ----
	registerJiraTools(ctx, resolveJiraSettings)
	registerConfluenceTools(ctx, resolveConfluenceSettings)

	// /hello 通道的处理器：客户端经 ctx.connection.rpc.call('/hello', endpoint, { args }) 调用。
	const handleHello: ConnectionRpcHandler = async (endpoint, payload, signal): Promise<ConnectionRpcResult<unknown>> => {
		const args = (payload as { args?: Record<string, unknown> } | undefined)?.args ?? {}

		// 注册 /ping 通道，用于测试连接
		// 请求参数：
		//   name: 客户端显示的名称（可选）
		// 返回结果：{ ok: true, value: 'pong from host, hello <display>!' }</display>}
		if (endpoint === 'ping') {
			const nameArg = args.name
			const display = typeof nameArg === 'string' ? nameArg : '(anonymous)'
			console.log('client ping:', display)
			return { ok: true, value: `pong from host, hello ${display}!` }
		}

		// 注册 /jira/todos 通道，用于获取 Jira 待办事项列表
		// 请求参数：无
		if (endpoint === 'jira/todos') {
			try {
				// 获取 Jira 配置
				const settings = resolveJiraSettings()
				// 使用获取到的 Jira 配置去获取待办事项列表
				const todos = await fetchJiraTodos(settings)
				return { ok: true, value: todos }
			} catch (error) {
				if (error instanceof JiraConfigError) return rpcFailure(error.code, error.message)
				logger.warn('jira/todos failed:', String(error))
				return rpcFailure('jira-error', `读取 Jira 待办失败：${String(error)}`)
			}
		}
		// 注册 /jira/analyze 通道，用于发起对 Jira issue 的 Agent 会话分析
		// 请求参数：
		//   key: Jira issue 的 key
		// 返回结果：{ sessionId }——分析会话已创建并在后台运行（归入左侧「Jira 分析」工作区），
		// 宿主不等待 Agent 完成；分析结果 / 失败随后经 events/poll 长轮询事件
		// jira/analysis-done / jira/analysis-failed 推送（见下方 emit 调用）。
		if (endpoint === 'jira/analyze') {
			const key = typeof args.key === 'string' ? args.key : ''
			if (key === '') return rpcFailure('bad-request', '缺少 key 参数')
			if (llmConfig.provider === undefined || llmConfig.model === undefined) {
				return rpcFailure('llm-not-configured', 'llm.config.json 未配置 provider/model')
			}
			if (ctx.get('agents') === undefined) return rpcFailure('agents-unavailable', 'agents 服务不可用')
			let summary: string
			try {
				// 预检：校验 Jira 配置与 issue 存在，并拿到 summary（供会话标题与任务消息使用）
				const issue = await fetchJiraIssueSummary(resolveJiraSettings(), key)
				summary = issue.summary
			} catch (error) {
				if (error instanceof JiraConfigError) return rpcFailure(error.code, error.message)
				logger.warn('jira/analyze preflight failed:', String(error))
				return rpcFailure('jira-error', `读取 Jira issue 失败：${String(error)}`)
			}
			const sessionId = 'jira-' + randomUUID()
			// 后台驱动分析会话（不阻塞 RPC）；完成后/失败时经 emit 推送给前端
			void runJiraAnalysisSession(ctx, { llmConfig, sessionId, key, summary })
				.then((result) => {
					// 分析会话完成，通知前端
					logger.info('jira analysis done:', result.key, result.sessionId)
					emit('jira/analysis-done', [{
						key: result.key,
						summary: result.summary,
						analysis: result.analysis,
						sessionId: result.sessionId,
					}])
				})
				.catch((error) => {
					logger.warn('jira analysis failed:', String(error))
					emit('jira/analysis-failed', [{
						sessionId,
						message: error instanceof Error ? error.message : String(error),
					}])
				})
			return { ok: true, value: { sessionId } }
		}

		// 注册 /jira/comment 通道，用于向 Jira issue 添加评论
		// 请求参数：
		//   key: Jira issue 的 key
		//   text: 评论内容
		if (endpoint === 'jira/comment') {
			const key = typeof args.key === 'string' ? args.key : ''
			const text = typeof args.text === 'string' ? args.text.trim() : ''
			if (key === '') return rpcFailure('bad-request', '缺少 key 参数')
			if (text === '') return rpcFailure('bad-request', '缺少评论内容')
			try {
				// 提交评论到 Jira
				await addJiraComment(resolveJiraSettings(), key, text)
				return { ok: true, value: { added: true } }
			} catch (error) {
				if (error instanceof JiraConfigError) return rpcFailure(error.code, error.message)
				logger.warn('jira/comment failed:', String(error))
				return rpcFailure('jira-error', `添加 Jira 评论失败：${String(error)}`)
			}
		}
		// 注册 /news/start 通道
		// 启动 Google 新闻订阅，返回 sessionId
		if (endpoint === 'news/start') {
			if (llmConfig.provider === undefined || llmConfig.model === undefined) {
				return rpcFailure('llm-not-configured', 'llm.config.json 未配置 provider/model')
			}
			// 获取 agents 服务（官方 dsh-agent 类型）
			const agents = ctx.get('agents') as AgentRegistry | undefined
			if (agents === undefined) {
				return rpcFailure('agents-unavailable', 'agents 服务不可用')
			}
			// 创建一个 sessionId
			const sessionId = 'news-' + randomUUID()
			latestNews = { sessionId, state: 'running' }
			try {
				// 获取 workspaceRegistry 服务（官方 dsh-workspace 类型）
				const workspaceRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
				// 工作目录，使用 process.cwd() 获取当前工作目录
				const cwd = process.cwd()
				// 创建 workspace，如果 workspaceRegistry 不可用，则返回 undefined
				const workspace = workspaceRegistry === undefined
					? undefined
					: await workspaceRegistry.create(cwd, '新闻头条')
				// 如果 workspace 创建成功，则设置标题为“新闻头条”  
				if (workspace !== undefined) await workspace.setTitle('新闻头条')
				// 创建一个新的 agent 会话，使用 llmConfig 中的 provider 和 model，并安装 google_news 工具
				/***
				 * 1. 创建 agentCtx
				 * 2. 执行 setup(agentCtx)
				 * 3. 执行 commit()
				 * 4. 注册 session
				 * 5. 注册 agent
				 * 6. 发出 created 事件
				 * 7. Agent 开始工作
				 ***/
				const handle = await agents.create({
					// 使用随机生成的 sessionId
					sessionId: sessionId as never,
					meta: { cwd },
					// 设置 agent 的选项，包括 provider 和 model
					agentOptions: { provider: llmConfig.provider, model: llmConfig.model },
					// 设置 setup 函数, 用于Agent的配置 ，用于安装 google_news 工具
					setup: (agentCtx: Context) => {
						// 安装 google_news 工具
						installGoogleNewsTool(agentCtx)
					},
				})
				// 如果 workspace 创建成功，则将 sessionId 添加到 workspace 中
				if (workspace !== undefined) await workspace.attachSession(sessionId as SessionId)
				const now = new Date()
				// 获取当前时间的本地化字符串，格式为“时:分:秒”，不使用 12 小时制,
				const stamp = now.toLocaleTimeString('zh-CN', { hour12: false });
				// 重命名 agent 会话的标题为“获取新闻 + 时间戳”（sessionTitle 由 dsh-session-title 增强提供类型）
				ctx.sessionTitle.rename(handle.agent.session, `获取新闻 ${stamp}`)
				// 发送一条用户消息，要求使用 google_news 工具获取最新 Google 新闻，并用简洁的中文总结当前最重要的 5 条新闻，每条附链接	
				// followup = 新的一轮对话
				// steer = 当前任务的方向修正
				// inject = 补充上下文
				// cancel = 停止执行
				// whenIdle = 等待结束
				// runMaintenance = 空闲时做后台维护
				// 			     Agent
				//                 │
				//     ┌───────────┼───────────┐
				//     │           │           │
				//  followup    steer      inject
				//     │           │           │
				//     └──────► Inbox ◄────────┘
				//                 │
				//                 ▼
				//            Driver Loop
				//                 │
				//         Prompt Assembly
				//                 │
				//               Model
				//                 │
				//             Tool Call
				//                 │
				//            Session Log
				handle.agent.followup(createUserMessage({
					content: [{
						type: 'text' as const,
						text: '请使用 google_news 工具获取最新 Google 新闻，然后用简洁的中文总结当前最重要的 5 条新闻，每条附链接。',
					}],
					source: { kind: 'plugin' as const, plugin: name },
				}))
				// 后台等会话静止（Agent 跑完这一轮，模型失败也会 resolve），再经长轮询推
				// news/done / news/failed 给前端，解除「获取新闻」按钮的禁用态。
				// 注意 whenIdle 返回后会话不 dispose —— 保留在左侧「新闻头条」工作区供查看。
				void handle.agent.whenIdle()
					.then(() => {
						logger.info('news session idle:', sessionId)
						// if (latestNews?.sessionId === sessionId) latestNews = { sessionId, state: 'done' }
						// emit('news/done', [{ sessionId }])
					})
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error)
						logger.warn('news session failed:', sessionId, message)
						// if (latestNews?.sessionId === sessionId) latestNews = { sessionId, state: 'failed', error: message }
						// emit('news/failed', [{ sessionId, message }])
					})
				return { ok: true, value: { sessionId } }
			} catch (error) {
				logger.warn('news/start failed:', String(error))
				// 会话没能跑起来：同样落到 failed，否则 /agent/status 会一直停在 running
				latestNews = { sessionId, state: 'failed', error: String(error) }
				return rpcFailure('news-error', `发起新闻会话失败：${String(error)}`)
			}
		}
		// 注册 /agent/status 通道：查询 Agent 的实时状态.
		// 输入：{ sessionId? }
		// 返回：{ sessionId, state: 'running'|'done'|'failed', error? } | null
		if (endpoint === 'agent/status') {
			// 获取sessionId
			const sessionIdArg = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : null
			if (sessionIdArg === null) {
				// 获取 latestNews
				return { ok: true, value: "failed" }
			}
			// 获取agents 服务（官方 dsh-agent 类型）
			const agents = ctx.get('agents') as AgentRegistry | undefined
			// 获取该sessionId对应的Agent
			const agent = sessionIdArg !== null && agents !== undefined
				? agents.get(sessionIdArg as SessionId)
				: undefined
			if (agent !== undefined && sessionIdArg !== null) {
				// Agent.status 官方取值 'idle' | 'running'，映射到客户端的 NewsStatus 状态模型
				return {
					ok: true,
					value: { sessionId: sessionIdArg, state: agent.status === 'running' ? 'running' : 'done' },
				}
			} else {
				return { ok: true, value: { sessionId: sessionIdArg, state: 'failed' } }
			}

		}
		// 注册 /events/poll 通道，用于轮询事件
		// 请求参数：无
		// 返回结果：
		//   ok: 是否成功
		//   value: 事件列表（如果 ok 为 true）
		if (endpoint === 'events/poll') {
			// 如果有待处理的事件，立即返回这些事件给客户端
			if (pending.length > 0) {
				return { ok: true, value: pending.splice(0) }
			}
			// 如果没有待处理的事件，则等待新的事件到来，或者超时返回 null
			const events = await new Promise<PendingEvent[] | null>((resolve) => {
				let entry: { resolve: (value: PendingEvent[] | null) => void; timer: NodeJS.Timeout }
				const timer = setTimeout(() => {
					const index = waiters.indexOf(entry)
					if (index !== -1) waiters.splice(index, 1)
					resolve(null)
				}, POLL_TIMEOUT_MS)
				entry = {
					resolve: (value) => {
						clearTimeout(timer)
						resolve(value)
					},
					timer,
				}
				waiters.push(entry)
				signal.addEventListener('abort', () => {
					const index = waiters.indexOf(entry)
					if (index !== -1) waiters.splice(index, 1)
					clearTimeout(timer)
					resolve(null)
				}, { once: true })
			})
			if (events === null) return { ok: true, value: [] }
			return { ok: true, value: events }
		}

		return rpcFailure('bad-request', `unknown endpoint: ${endpoint}`)
	}

	// 注册 /hello 通道。注意：**不用** `ctx.connection.rpc.handle` —— 新版 harness 的该 API
	// 把通道挂到 connection 插件自身 ctx 的 webServer 上（解析起点是 connection 的 fiber，
	// 消费方无法通过声明依赖满足），实测必抛 `cannot get property "webServer" without inject`。
	// 改为自建等价路由：见 src/host/web-channel.ts（复用 connection.requestRejection 栅栏 +
	// Connection RPC 信封，客户端半区零改动）。
	mountHelloChannel(ctx, handleHello)

	// 每 5 秒自动发一个事件，证明「host 主动触发」不需要任何客户端请求。
	ctx.effect(() => {
		const timer = setInterval(() => {
			emit('hello/notice', ['host is alive at ' + new Date().toLocaleTimeString()])
		}, 5_000)
		return () => clearInterval(timer)
	})
}
