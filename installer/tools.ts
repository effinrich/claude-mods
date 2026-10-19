import { join } from 'node:path'
import type { ToolName } from '../runner/types.ts'
import { readJsonObject, type Plan } from './files.ts'

export const RUNTIME_MARKER = 'claude-mods'

type HookSpec = { event: string; matcher?: string; timeoutSeconds?: number }

const LONG = 900 // seconds: stop and commit hooks may run the full check suite.

// Per tool: the events the runner handles, from each tool's hook reference (see tasks/todo.md).
export const HOOKS: Readonly<Record<ToolName, readonly HookSpec[]>> = {
  codex: [
    { event: 'PreToolUse', matcher: '^(Bash|apply_patch|Edit|Write)$', timeoutSeconds: LONG },
    { event: 'UserPromptSubmit' },
    { event: 'Stop', timeoutSeconds: LONG },
    { event: 'PreCompact' },
    { event: 'SessionStart' },
  ],
  gemini: [
    { event: 'BeforeTool', matcher: 'run_shell_command|replace|write_file', timeoutSeconds: LONG },
    { event: 'BeforeAgent' },
    { event: 'AfterAgent', timeoutSeconds: LONG },
    { event: 'PreCompress' },
    { event: 'SessionStart' },
  ],
  cursor: [
    { event: 'beforeShellExecution', timeoutSeconds: LONG },
    { event: 'preToolUse', matcher: 'Write|Delete' },
    { event: 'afterFileEdit' },
    { event: 'beforeSubmitPrompt' },
    { event: 'stop', timeoutSeconds: LONG },
    { event: 'preCompact' },
    { event: 'sessionStart' },
  ],
  copilot: [
    { event: 'preToolUse', matcher: 'bash|powershell|edit|create|apply_patch|str_replace_editor', timeoutSeconds: LONG },
    { event: 'userPromptSubmitted' },
    { event: 'agentStop', timeoutSeconds: LONG },
    { event: 'preCompact' },
    { event: 'sessionStart' },
  ],
}

export const configDir = (home: string, tool: ToolName): string =>
  join(home, { codex: '.codex', gemini: '.gemini', cursor: '.cursor', copilot: '.copilot' }[tool])

export const hookConfigPath = (home: string, tool: ToolName): string =>
  ({
    codex: join(home, '.codex', 'hooks.json'),
    gemini: join(home, '.gemini', 'settings.json'),
    cursor: join(home, '.cursor', 'hooks.json'),
    copilot: join(home, '.copilot', 'hooks', 'claude-mods.json'),
  })[tool]

export const instructionsPath = (home: string, tool: ToolName): string | undefined =>
  ({
    codex: join(home, '.codex', 'AGENTS.md'),
    gemini: join(home, '.gemini', 'GEMINI.md'),
    cursor: undefined, // Cursor user rules live in its settings UI, not in a file.
    copilot: join(home, '.copilot', 'copilot-instructions.md'),
  })[tool]

export const hookCommand = (runtimeMain: string, tool: ToolName, event: string): string =>
  `node "${runtimeMain}" ${tool} ${event}`

const isOurs = (entry: unknown): boolean => JSON.stringify(entry).includes(RUNTIME_MARKER)

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}

// Our entries are found by the runtime path in their command, so re-running replaces them and leaves the user's alone.
const mergeEvents = (
  existing: Record<string, unknown>,
  ours: Readonly<Record<string, unknown[]>>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(existing)) {
    const kept = asArray(entries).filter(entry => !isOurs(entry))
    if (kept.length > 0) merged[event] = kept
  }
  for (const [event, entries] of Object.entries(ours)) merged[event] = [...asArray(merged[event]), ...entries]
  return merged
}

const ourEntries = (tool: ToolName, runtimeMain: string): Record<string, unknown[]> => {
  const entries: Record<string, unknown[]> = {}
  for (const spec of HOOKS[tool]) {
    const command = hookCommand(runtimeMain, tool, spec.event)
    const timeout = spec.timeoutSeconds
    const entry = (() => {
      switch (tool) {
        case 'codex':
          return {
            ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
            hooks: [{ type: 'command', command, ...(timeout === undefined ? {} : { timeout }), statusMessage: 'claude-mods' }],
          }
        case 'gemini':
          return {
            ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
            hooks: [{ name: 'claude-mods', type: 'command', command, ...(timeout === undefined ? {} : { timeout: timeout * 1000 }) }],
          }
        case 'cursor':
          return {
            command,
            ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
            ...(timeout === undefined ? {} : { timeout }),
            ...(spec.event === 'stop' ? { loop_limit: 3 } : {}),
          }
        case 'copilot':
          return {
            type: 'command',
            bash: command,
            powershell: command,
            ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
            timeoutSec: timeout ?? 30,
          }
      }
    })()
    entries[spec.event] = [entry]
  }
  return entries
}

export const planHooks = (plan: Plan, home: string, tool: ToolName, runtimeMain: string | undefined): void => {
  const path = hookConfigPath(home, tool)
  if (tool === 'copilot') {
    // Copilot reads every *.json in ~/.copilot/hooks/, so the whole file is ours.
    if (runtimeMain === undefined) plan.remove(path, true)
    else plan.write(path, `${JSON.stringify({ version: 1, hooks: ourEntries(tool, runtimeMain) }, null, 2)}\n`, true)
    return
  }
  const existing = readJsonObject(path)
  if (existing === 'invalid') {
    plan.note(`${tool}: ${path} is not plain JSON (comments?), so it was left alone. Add the hooks by hand; see README.`)
    return
  }
  const ours = runtimeMain === undefined ? {} : ourEntries(tool, runtimeMain)
  const hooks = mergeEvents(record(existing.hooks), ours)
  const next: Record<string, unknown> = { ...existing, hooks }
  if (tool === 'cursor') next.version ??= 1
  if (Object.keys(hooks).length === 0) delete next.hooks
  plan.write(path, `${JSON.stringify(next, null, 2)}\n`)
}

export const countOurHooks = (home: string, tool: ToolName): number => {
  const existing = readJsonObject(hookConfigPath(home, tool))
  if (existing === 'invalid') return 0
  return Object.values(record(existing.hooks)).flatMap(asArray).filter(isOurs).length
}
