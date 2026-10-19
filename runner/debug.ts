import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMaybeJson } from './adapters/shared.ts'
import { modsHome } from './state.ts'
import type { Config } from './types.ts'

const MAX_STRING = 200
const MAX_ITEMS = 10
const MAX_DEPTH = 4
const MAX_LOG_BYTES = 2 * 1024 * 1024

export const payloadLogPath = (): string => join(modsHome(), 'payloads.log')

export const isDebugOn = (config: Pick<Config, 'debug'>, env: NodeJS.ProcessEnv = process.env): boolean =>
  env.CLAUDE_MODS_DEBUG === '1' || env.CLAUDE_MODS_DEBUG === 'true' || config.debug

// Enough of the shape to pin undocumented field names, without dumping whole files into the log.
export const truncate = (value: unknown, depth = 0): unknown => {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value
  if (typeof value !== 'object' || value === null) return value
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[array of ${value.length}]` : '{…}'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map(item => truncate(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncate(item, depth + 1)]))
}

// Tool arguments sit under different names per tool (Copilot sends toolArgs as a JSON string).
const argumentKeys = (payload: Readonly<Record<string, unknown>>): string[] | undefined => {
  const args = payload.tool_input ?? payload.toolArgs ?? payload.tool_args
  return args === undefined ? undefined : Object.keys(parseMaybeJson(args))
}

export const capturePayload = (tool: string, event: string, payload: Readonly<Record<string, unknown>>, now: Date): void => {
  try {
    const path = payloadLogPath()
    mkdirSync(modsHome(), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    const toolArgs = payload.toolArgs
    const entry = {
      at: now.toISOString(),
      tool,
      event,
      keys: Object.keys(payload),
      argumentKeys: argumentKeys(payload),
      payload: truncate(typeof toolArgs === 'string' ? { ...payload, toolArgs: parseMaybeJson(toolArgs) } : payload),
    }
    writeFileSync(path, `${JSON.stringify(entry)}\n`, { flag: 'a' })
  } catch {
    // Capture is a diagnostic; it must never break a hook.
  }
}
