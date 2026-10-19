import { parsePatch } from '../patch.ts'
import { rec, str, type Adapter, type HookEvent } from '../types.ts'
import { absolute, json, NOTHING } from './shared.ts'

// https://learn.chatgpt.com/docs/hooks: edits arrive as tool `apply_patch` with the patch in tool_input.command.
const parse = (event: string, payload: Readonly<Record<string, unknown>>): HookEvent => {
  const sessionId = str(payload.session_id) ?? 'default'
  const cwd = str(payload.cwd) ?? process.cwd()
  const base = { sessionId, cwd }
  switch (event) {
    case 'PreToolUse': {
      const tool = str(payload.tool_name)
      const command = str(rec(payload.tool_input).command)
      if (command === undefined) return { kind: 'ignore' }
      if (tool === 'Bash') return { ...base, kind: 'shell', command }
      const edits = parsePatch(command).map(edit => ({ ...edit, path: absolute(edit.path, cwd) }))
      return edits.length > 0 ? { ...base, kind: 'edit', edits } : { kind: 'ignore' }
    }
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt', text: str(payload.prompt) ?? '' }
    case 'Stop':
      return { ...base, kind: 'stop', isRepeat: payload.stop_hook_active === true }
    case 'PreCompact':
      return { ...base, kind: 'precompact' }
    case 'SessionStart':
      return { ...base, kind: 'sessionStart', source: str(payload.source) }
    default:
      return { kind: 'ignore' }
  }
}

export const codex: Adapter = {
  capabilities: { promptContext: true },
  parse,
  emit: (event, verdict) => {
    switch (verdict.kind) {
      case 'deny':
        return json({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: verdict.reason } })
      case 'continue':
        return json({ decision: 'block', reason: verdict.reason })
      case 'context':
        return json({ hookSpecificOutput: { hookEventName: event, additionalContext: verdict.text } })
      case 'notice':
        return json({ systemMessage: verdict.text })
      case 'allow':
        return NOTHING
    }
  },
}
