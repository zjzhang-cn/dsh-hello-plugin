import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { name } from './constants'
import type { LlmConfig } from './types'

/**
 * 用 Agent 会话分析一个 Jira issue，替代对 ctx.llm 的直接调用。
 *
 * 流程：创建新会话（归入独立「Jira 分析」工作区，左侧工作区可见）→ 发一条用户消息，
 * 要求 Agent 先调用全局可见的 jira_get_issue 工具取详情再输出分析 → 等会话静止
 * （agent.whenIdle）→ 从会话日志折叠出最终文本返回。会话不 dispose，留在左侧供查看/续聊。
 *
 * 服务与类型均来自官方 @deepseek-ai/* 包（type-only 引用，运行时无新增依赖）：
 * agents / sessionTitle / workspaceRegistry 由各自的 cordis Context 模块增强提供类型。
 */

/** 分析会话归入的工作区标题（路径用插件包根目录，与「新闻头条」cwd 工作区互不冲突）。 */
const WORKSPACE_TITLE = 'Jira 分析'

/** 插件包根目录：bundle 位于 <root>/lib/host.js（dev 与安装模式一致），真实存在、可作 workspace 路径。 */
const WORKSPACE_PATH = dirname(dirname(fileURLToPath(import.meta.url)))

/** Agent 会话分析结果（供宿主经长轮询事件推给前端）。 */
export interface JiraAgentAnalysis {
	key: string
	summary: string
	analysis: string
	sessionId: string
}

/** 分析会话的运行参数。 */
export interface RunJiraAnalysisOptions {
	llmConfig: LlmConfig
	sessionId: string
	key: string
	summary: string
}

/**
 * 当前时间的 HH:mm:ss 字符串（zh-CN，24 小时制），用于会话标题。
 */
function timeStamp(): string {
	return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

/** 组装给 Agent 的任务消息：带上 key + summary，要求先用 jira_get_issue 工具取完整详情再分析。 */
function buildTaskPrompt(key: string, summary: string): string {
	return [
		`请分析 Jira issue ${key}（标题：${summary}）。`,
		`步骤：先用 jira_get_issue 工具获取该 issue 的完整详情（描述与已有评论），再输出分析。`,
		`分析请用简洁的中文总结三点：它要解决什么问题、当前状态与关键信息、可能的下一步。只输出分析内容本身，不要客套。`,
		`注意：本任务只做分析，禁止调用任何写操作工具（jira_add_comment、jira_update_status、jira_create_issue、confluence_create_page、confluence_update_page、confluence_add_comment）。`,
	].join('\n')
}

/**
 * 从事件日志里折叠最终答复文本（headless 范式）：
 * 每条 assistant/message 只取 text 块，非空则覆盖「最终文本」（中间含 tool-call 的回合自然被跳过）；
 * 最后一条 turn/end 的 reason 为 error / aborted 视为失败。
 * 事件为官方 SessionEvent 判别联合：turn/end 的 data.reason 即 TurnEndReason（error 带 LlmFailure.message），
 * assistant/message 的 data.message.content 为 dsh-llm 的 ContentBlock[]。
 */
function collectAnalysisText(events: readonly SessionEvent[]): string {
	let finalText = ''
	let failureMessage: string | null = null
	for (const event of events) {
		if (event.type === 'turn/end') {
			const reason = event.data.reason
			if (reason.kind === 'error') {
				failureMessage = reason.error.message !== ''
					? reason.error.message
					: 'Agent 会话执行出错'
			} else if (reason.kind === 'aborted') {
				failureMessage = 'Agent 会话执行被中止'
			}
			continue
		}
		if (event.type === 'assistant/message') {
			const text = event.data.message.content
				.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
				.map((block) => block.text ?? '')
				.join('')
				.trim()
			if (text !== '') finalText = text
		}
	}
	if (failureMessage !== null) throw new Error(failureMessage)
	if (finalText === '') throw new Error('Agent 未返回有效内容')
	return finalText
}

/**
 * 取 [boundary, 日志末尾) 的会话事件。
 * 两个候选 API 并存：harness 工作区源码（dev 运行面）的 Session 提供 `events` 快照 getter
 * （packages/core/session/src/index.ts:557），而已发布 0.1.2-rc.1 的类型标注的是
 * `snapshotEvents(fromSeq?, toSeqExclusive?)`——两者版本错位，这里运行时特性探测取其一。
 */
function snapshotEventsFrom(session: Session, boundary: number): readonly SessionEvent[] {
	const accessor = session as unknown as {
		events?: readonly SessionEvent[]
		snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
	}
	if (Array.isArray(accessor.events)) return accessor.events.slice(boundary)
	if (typeof accessor.snapshotEvents === 'function') return accessor.snapshotEvents(boundary)
	throw new Error('Session 实例缺少 events / snapshotEvents 访问器')
}

/**
 * 创建并驱动一次 Jira 分析会话，等待完成后返回分析文本。
 * 会话创建后经 workspaceRegistry.attachSession 归入「Jira 分析」工作区（可选服务缺失则跳过），
 * 完成后**不 dispose** —— 会话保留在左侧工作区，可点开查看完整过程或继续对话。
 */
export async function runJiraAnalysisSession(
	ctx: Context,
	options: RunJiraAnalysisOptions,
): Promise<JiraAgentAnalysis> {
	const { llmConfig, sessionId, key, summary } = options
	// SessionId 是 dsh-session 的 brand：sessionId 由本插件生成（'jira-' + uuid），断言仅作用在类型层
	const sid = sessionId as SessionId
	const agents = ctx.get('agents') as AgentRegistry | undefined
	if (agents === undefined) throw new Error('agents 服务不可用')
	// 工作区：workspaceRegistry 为可选服务（同 news/start），拿不到时跳过 attach，不影响分析
	const workspaceRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
	const workspace = workspaceRegistry === undefined
		? undefined
		: await workspaceRegistry.create(WORKSPACE_PATH, WORKSPACE_TITLE)

	const handle = await agents.create({
		sessionId: sid,
		meta: { cwd: WORKSPACE_PATH },
		// agent 的模型取自 llm.config.json；jira_* 工具已全局注册（apply 顶层 ctx.tools），
		// 该会话的 Agent 可见（tools.view 合并 global 层），无需在 setup 里再注册
		agentOptions: { provider: llmConfig.provider, model: llmConfig.model },
	})
	const agent = handle.agent
	if (workspace !== undefined) {
		await workspace.attachSession(sid)
	}
	ctx.sessionTitle.rename(agent.session, `分析 ${key} ${timeStamp()}`)

	// 记录事件边界后发任务：boundary 之后的事件才属于本次分析
	const boundary = agent.session.seq
	// 发送用户消息，触发 Jira 分析任务
	agent.followup(createUserMessage({
		content: [{ type: 'text' as const, text: buildTaskPrompt(key, summary) }],
		source: { kind: 'plugin' as const, plugin: name },
	}))
	await agent.whenIdle()

	const analysis = collectAnalysisText(snapshotEventsFrom(agent.session, boundary))
	return { key, summary, analysis, sessionId }
}
