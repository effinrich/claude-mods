import { rec, str, type Adapter, type HookEvent } from '../types.ts'
import { absolute, json } from './shared.ts'

// https://geminicli.com/docs/hooks/reference/ and /docs/reference/tools/.
const parse = (event: string, payload: Readonly<Record<string, unknown>>): HookEvent => {
  const sessionId = str(payload.session_id) ?? 'default'
  const cwd = str(payload.cwd) ?? process.cwd()
  const base = { sessionId, cwd }
  switch (event) {
    case 'BeforeTool': {
      const input = rec(payload.tool_input)
      const path = str(input.file_path)
      switch (str(payload.tool_name)) {
        case 'run_shell_command': {
          const command = str(input.command)
          return command === undefined ? { kind: 'ignore' } : { ...base, kind: 'shell', command }
        }
        case 'replace':
          return path === undefined
            ? { kind: 'ignore' }
            : { ...base, kind: 'edit', edits: [{ path: absolute(path, cwd), newText: str(input.new_string) ?? '', oldText: str(input.old_string) ?? '' }] }
        case 'write_file':
          return path === undefined
            ? { kind: 'ignore' }
            : { ...base, kind: 'edit', edits: [{ path: absolute(path, cwd), newText: str(input.content) ?? '', oldText: undefined }] }
        default:
          return { kind: 'ignore' }
      }
    }
    case 'BeforeAgent':
      return { ...base, kind: 'prompt', text: str(payload.prompt) ?? '' }
    case 'AfterAgent':
      return { ...base, kind: 'stop', isRepeat: payload.stop_hook_active === true }
    case 'PreCompress':
      return { ...base, kind: 'precompact' }
    case 'SessionStart':
      return { ...base, kind: 'sessionStart', source: str(payload.source) }
    default:
      return { kind: 'ignore' }
  }
}

export const gemini: Adapter = {
  capabilities: { promptContext: true },
  parse,
  // Gemini parses stdout as JSON on exit 0, so every reply is a JSON object, even an empty one.
  emit: (event, verdict) => {
    switch (verdict.kind) {
      case 'deny':
        return json({ decision: 'deny', reason: verdict.reason })
      case 'continue':
        return json({ decision: 'block', reason: verdict.reason })
      case 'context':
        return json({ hookSpecificOutput: { hookEventName: event, additionalContext: verdict.text } })
      case 'notice':
        return json({ systemMessage: verdict.text })
      case 'allow':
        return json({})
    }
  },
}
