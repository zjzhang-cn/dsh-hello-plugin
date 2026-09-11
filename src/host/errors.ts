import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

export class JiraConfigError extends Error {
  readonly code = 'jira-not-configured'
}

export class ConfluenceConfigError extends Error {
  readonly code = 'confluence-not-configured'
}

export function rpcFailure(code: string, message: string): ConnectionRpcResult<unknown> {
  return { ok: false, error: { code, message, details: {} } }
}
