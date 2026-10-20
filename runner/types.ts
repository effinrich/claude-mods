export type ToolName = 'codex' | 'gemini' | 'cursor' | 'copilot'

export const TOOLS: readonly ToolName[] = ['codex', 'gemini', 'cursor', 'copilot']

// oldText undefined means a whole-file write: the engine reads what is on disk now to compare against.
export type FileEdit = { path: string; newText: string; oldText: string | undefined }

type Base = { sessionId: string; cwd: string }

// What every tool's hook payload is reduced to before any rule runs.
export type HookEvent =
  | (Base & { kind: 'edit'; edits: readonly FileEdit[] })
  | (Base & { kind: 'edited'; paths: readonly string[] })
  | (Base & { kind: 'shell'; command: string })
  | (Base & { kind: 'prompt'; text: string })
  | (Base & { kind: 'stop'; isRepeat: boolean; lastMessage?: string })
  | (Base & { kind: 'precompact' })
  | (Base & { kind: 'sessionStart'; source: string | undefined })
  | { kind: 'ignore' }

// What the rules decide; each adapter writes it in its tool's own format.
export type Verdict =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'continue'; reason: string }
  | { kind: 'context'; text: string }
  | { kind: 'notice'; text: string }

export type HookReply = { stdout: string; stderr: string; exitCode: number }

export type Capabilities = {
  // Whether the tool can add context at prompt submit; without it, the handoff returns at session start only.
  promptContext: boolean
}

export type Adapter = {
  capabilities: Capabilities
  parse: (event: string, payload: Readonly<Record<string, unknown>>) => HookEvent
  emit: (event: string, verdict: Verdict) => HookReply
}

export type Config = {
  mods: { guardrails: boolean; compactionGuard: boolean; contextAudit: boolean }
  stopGate: boolean
  draftSpecs: boolean
  writingGate: boolean
  allowImports: readonly string[]
  checkTimeoutMs: number
  // Append each raw hook payload to ~/.claude-mods/payloads.log (also on with CLAUDE_MODS_DEBUG=1).
  debug: boolean
}

export const DEFAULT_CONFIG: Config = {
  mods: { guardrails: true, compactionGuard: true, contextAudit: true },
  stopGate: true,
  draftSpecs: true,
  writingGate: true,
  allowImports: [],
  checkTimeoutMs: 10 * 60_000,
  debug: false,
}

export const ALLOW: Verdict = { kind: 'allow' }

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export const rec = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
