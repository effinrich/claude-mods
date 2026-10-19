import { parsePatch } from '../patch.ts'
import { str, type Adapter, type HookEvent } from '../types.ts'
import { absolute, firstString, json, NOTHING, parseMaybeJson } from './shared.ts'

const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'powershell'])
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'create', 'apply_patch', 'str_replace_editor'])

// https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference. Edit arguments are not
// documented, so the likely names are tried; an edit with no recognisable path is let through rather than guessed at.
const parseEdit = (tool: string, args: Readonly<Record<string, unknown>>, cwd: string) => {
  const patch = Object.values(args).find((value): value is string => typeof value === 'string' && value.includes('*** Begin Patch'))
  if (patch !== undefined) return parsePatch(patch).map(edit => ({ ...edit, path: absolute(edit.path, cwd) }))
  const path = firstString(args, ['path', 'file_path', 'filePath'])
  if (path === undefined) return []
  const newText = firstString(args, ['new_str', 'new_string', 'file_text', 'content', 'newText']) ?? ''
  const oldText = tool === 'create' ? undefined : firstString(args, ['old_str', 'old_string', 'oldText'])
  return [{ path: absolute(path, cwd), newText, oldText }]
}

const parse = (event: string, payload: Readonly<Record<string, unknown>>): HookEvent => {
  const sessionId = str(payload.sessionId) ?? str(payload.session_id) ?? 'default'
  const cwd = str(payload.cwd) ?? process.cwd()
  const base = { sessionId, cwd }
  switch (event) {
    case 'preToolUse': {
      const tool = str(payload.toolName) ?? ''
      const args = parseMaybeJson(payload.toolArgs)
      if (SHELL_TOOLS.has(tool)) {
        const command = str(args.command)
        return command === undefined ? { kind: 'ignore' } : { ...base, kind: 'shell', command }
      }
      if (!EDIT_TOOLS.has(tool)) return { kind: 'ignore' }
      const edits = parseEdit(tool, args, cwd)
      return edits.length > 0 ? { ...base, kind: 'edit', edits } : { kind: 'ignore' }
    }
    case 'userPromptSubmitted':
      return { ...base, kind: 'prompt', text: firstString(payload, ['prompt', 'userPrompt']) ?? '' }
    case 'agentStop':
      return { ...base, kind: 'stop', isRepeat: payload.stop_hook_active === true }
    case 'preCompact':
      return { ...base, kind: 'precompact' }
    case 'sessionStart':
      return { ...base, kind: 'sessionStart', source: str(payload.source) }
    default:
      return { kind: 'ignore' }
  }
}

export const copilot: Adapter = {
  capabilities: { promptContext: false },
  parse,
  emit: (_event, verdict) => {
    switch (verdict.kind) {
      case 'deny':
        return json({ permissionDecision: 'deny', permissionDecisionReason: verdict.reason })
      case 'continue':
        return json({ decision: 'block', reason: verdict.reason })
      case 'context':
        return json({ additionalContext: verdict.text })
      case 'notice':
      case 'allow':
        return NOTHING
    }
  },
}
