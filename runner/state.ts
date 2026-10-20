import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { mergeProfiles, parseProfile, PROFILE_FILE, USER_PROFILE_FILE, type Profile } from '../core/profile.ts'
import { blockEntry } from '../core/rules.ts'
import { DEFAULT_CONFIG, type Config, type ToolName } from './types.ts'

// Each hook call is a fresh process, so what a session needs to remember lives in a small JSON file.
export type SessionState = {
  isDirty: boolean
  lastResult: 'pass' | 'fail' | undefined
  // Content hashes of the touched files when checks last passed; equal hashes mean the checks need not run again.
  passHashes: Record<string, string> | undefined
  // Working-tree fingerprints (git): at the start of the turn, and when checks last passed.
  turnStartFp: string | undefined
  passFp: string | undefined
  // Whether the last passing run was the full suite (commits need that) or the end-of-turn subset.
  lastPassFull: boolean
  claimChecked: boolean
  warnedNoChecks: boolean
  // Where the turn started (git), so the end of the turn can judge every change, shell edits included.
  turnBase: { commit: string; untracked: Record<string, string> } | undefined
  turnChangesChecked: boolean
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
  passHashes: undefined,
  turnStartFp: undefined,
  passFp: undefined,
  lastPassFull: false,
  claimChecked: false,
  warnedNoChecks: false,
  turnBase: undefined,
  turnChangesChecked: false,
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

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

// The user's profile, overridden by the repo's when a root is given.
export const loadProfile = (root?: string): Profile =>
  mergeProfiles(
    parseProfile(readText(join(modsHome(), USER_PROFILE_FILE))),
    root === undefined ? {} : parseProfile(readText(join(root, PROFILE_FILE))),
  )

export const applyProfile = (config: Config, profile: Profile): Config => {
  const settings = profile.guardrails ?? {}
  return {
    ...config,
    stopGate: settings.stopGate ?? config.stopGate,
    writingGate: settings.writingGate ?? config.writingGate,
    checkTimeoutMs: settings.checkTimeoutMinutes === undefined ? config.checkTimeoutMs : settings.checkTimeoutMinutes * 60_000,
  }
}

export const loadConfig = (root?: string): Config => {
  const stored = readJson(join(modsHome(), 'config.json')) as Partial<Config> | undefined
  return applyProfile({ ...DEFAULT_CONFIG, ...stored, mods: { ...DEFAULT_CONFIG.mods, ...stored?.mods } }, loadProfile(root))
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

const MAX_BLOCK_LOG_BYTES = 1024 * 1024

export const blockLogPath = (): string => join(modsHome(), 'blocks.log')

// Every block, hold and send-back, so `doctor` can show which rules fire and how often.
export const logBlock = (tool: string, reason: string, now: Date): void => {
  try {
    const path = blockLogPath()
    mkdirSync(modsHome(), { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_BLOCK_LOG_BYTES) writeFileSync(path, readFileSync(path, 'utf8').split('\n').slice(-2000).join('\n'))
    writeFileSync(path, `${JSON.stringify(blockEntry(tool, reason, now))}\n`, { flag: 'a' })
  } catch {
    // Logging must never break a hook.
  }
}
