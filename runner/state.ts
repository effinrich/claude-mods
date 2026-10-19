import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_CONFIG, type Config, type ToolName } from './types.ts'

// Each hook call is a fresh process, so what a session needs to remember lives in a small JSON file.
export type SessionState = {
  isDirty: boolean
  lastResult: 'pass' | 'fail' | undefined
  stopBlocks: number
  originalTask: string | undefined
  prompts: string[]
  touched: string[]
  pendingHandoff: string | undefined
}

const MAX_PROMPTS = 8
const MAX_TOUCHED = 25
const STATE_TTL_MS = 7 * 24 * 60 * 60_000

export const modsHome = (): string => process.env.CLAUDE_MODS_HOME ?? join(homedir(), '.claude-mods')

const emptyState = (): SessionState => ({
  isDirty: false,
  lastResult: undefined,
  stopBlocks: 0,
  originalTask: undefined,
  prompts: [],
  touched: [],
  pendingHandoff: undefined,
})

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const statePath = (tool: ToolName, sessionId: string): string =>
  join(modsHome(), 'state', `${tool}-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'default'}.json`)

export const loadState = (tool: ToolName, sessionId: string): SessionState => ({
  ...emptyState(),
  ...(readJson(statePath(tool, sessionId)) as Partial<SessionState> | undefined),
})

export const saveState = (tool: ToolName, sessionId: string, state: SessionState): void =>
  writeJson(statePath(tool, sessionId), state)

export const rememberPrompt = (state: SessionState, text: string): void => {
  state.originalTask ??= text
  state.prompts = [...state.prompts, text].slice(-MAX_PROMPTS)
}

export const rememberTouched = (state: SessionState, paths: readonly string[]): void => {
  state.touched = [...new Set([...paths, ...state.touched])].slice(0, MAX_TOUCHED)
}

export const loadConfig = (): Config => {
  const stored = readJson(join(modsHome(), 'config.json')) as Partial<Config> | undefined
  return { ...DEFAULT_CONFIG, ...stored, mods: { ...DEFAULT_CONFIG.mods, ...stored?.mods } }
}

export const handoffPath = (root: string): string => {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 6)
  return join(modsHome(), 'handoffs', `${basename(root) || 'project'}-${hash}.md`)
}

export const pruneOldState = (now: number): void => {
  const dir = join(modsHome(), 'state')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > STATE_TTL_MS) unlinkSync(path)
    } catch {
      // A file another hook removed first is fine.
    }
  }
}

export const log = (line: string): void => {
  try {
    mkdirSync(modsHome(), { recursive: true })
    writeFileSync(join(modsHome(), 'hook.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
  } catch {
    // Logging must never break a hook.
  }
}
