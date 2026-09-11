import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigLoaderLogger, ConfluenceSettings, JiraSettings, LlmConfig } from './types'

/** 从 bundle 所在目录逐级向上查找一个 JSON 配置文件。 */
export function loadProjectJsonConfig<T extends Record<string, unknown>>(
  filename: string,
  logger: ConfigLoaderLogger,
): T | null {
  const bundleDir = dirname(fileURLToPath(import.meta.url))
  let dir: string | undefined = bundleDir
  while (dir !== undefined && dir !== '/') {
    const candidate = join(dir, filename)
    try {
      const raw = readFileSync(candidate, 'utf8')
      const parsed = JSON.parse(raw) as T
      logger.info('%s loaded from %s', filename, candidate)
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        dir = dirname(dir)
        continue
      }
      logger.warn('%s parse failed at %s: %s', filename, candidate, String(error))
      dir = dirname(dir)
    }
  }
  return null
}

export function loadProjectJiraConfig(logger: ConfigLoaderLogger): JiraSettings | null {
  const parsed = loadProjectJsonConfig<Partial<JiraSettings>>('jira.config.json', logger)
  if (parsed === null) return null
  return {
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
    email: typeof parsed.email === 'string' ? parsed.email : undefined,
    apiToken: typeof parsed.apiToken === 'string' ? parsed.apiToken : undefined,
  }
}

export function loadProjectConfluenceConfig(logger: ConfigLoaderLogger): ConfluenceSettings | null {
  const parsed = loadProjectJsonConfig<Partial<ConfluenceSettings>>('confluence.config.json', logger)
  if (parsed === null) return null
  return {
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
    email: typeof parsed.email === 'string' ? parsed.email : undefined,
    apiToken: typeof parsed.apiToken === 'string' ? parsed.apiToken : undefined,
  }
}

export function loadProjectLlmConfig(logger: ConfigLoaderLogger): LlmConfig | null {
  const parsed = loadProjectJsonConfig<Partial<LlmConfig>>('llm.config.json', logger)
  if (parsed === null) return null
  return {
    provider: typeof parsed.provider === 'string' && parsed.provider !== '' ? parsed.provider : undefined,
    model: typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined,
  }
}
