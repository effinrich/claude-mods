import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parsePatch } from '../patch.ts'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js')

let root = ''
let env: NodeJS.ProcessEnv = {}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'claude-mods-adapter-'))
  root = join(base, 'app')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude/spec.md'), '---\nscope: [src/**]\n---\nTask.')
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { lint: `node -e "console.error('lint broke');process.exit(1)"` } }),
  )
  env = { ...process.env, CLAUDE_MODS_HOME: join(base, 'mods'), HOME: join(base, 'home') }
})

const hook = (tool: string, event: string, payload: unknown) => {
  const ran = spawnSync(process.execPath, [MAIN, tool, event], { input: JSON.stringify(payload), encoding: 'utf8', env })
  return { exitCode: ran.status, stdout: ran.stdout.trim(), json: ran.stdout.trim() === '' ? undefined : (JSON.parse(ran.stdout) as Record<string, unknown>) }
}

describe('codex', () => {
  const common = () => ({ session_id: 'c1', cwd: root, transcript_path: '', model: 'gpt-5' })

  test('denies a destructive Bash command in the documented PreToolUse shape', () => {
    const reply = hook('codex', 'PreToolUse', { ...common(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force' } })
    assert.equal(reply.exitCode, 0)
    const output = reply.json?.hookSpecificOutput as Record<string, string>
    assert.equal(output.hookEventName, 'PreToolUse')
    assert.equal(output.permissionDecision, 'deny')
    assert.match(output.permissionDecisionReason ?? '', /force-pushing/)
  })

  test('reads apply_patch edits and blocks a file outside the spec scope', () => {
    const patch = '*** Begin Patch\n*** Add File: docs/notes.md\n+hello\n*** End Patch\n'
    const reply = hook('codex', 'PreToolUse', { ...common(), tool_name: 'apply_patch', tool_input: { command: patch } })
    assert.match((reply.json?.hookSpecificOutput as Record<string, string>).permissionDecisionReason ?? '', /docs\/notes\.md is outside the scope/)
  })

  test('says nothing for an allowed call', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch\n'
    assert.deepEqual(hook('codex', 'PreToolUse', { ...common(), tool_name: 'apply_patch', tool_input: { command: patch } }), {
      exitCode: 0,
      stdout: '',
      json: undefined,
    })
  })

  test('keeps the agent going on Stop when checks fail after an edit', () => {
    hook('codex', 'PreToolUse', { ...common(), tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: src/b.ts\n+export {}\n*** End Patch' } })
    const reply = hook('codex', 'Stop', { ...common(), stop_hook_active: false })
    assert.equal(reply.json?.decision, 'block')
    assert.match(String(reply.json?.reason), /lint broke/)
  })

  test('hands the handoff back at SessionStart source=compact', () => {
    hook('codex', 'UserPromptSubmit', { ...common(), prompt: 'Build the desk.' })
    hook('codex', 'PreCompact', { ...common(), trigger: 'auto' })
    const reply = hook('codex', 'SessionStart', { ...common(), source: 'compact' })
    const output = reply.json?.hookSpecificOutput as Record<string, string>
    assert.equal(output.hookEventName, 'SessionStart')
    assert.match(output.additionalContext ?? '', /Build the desk\./)
  })
})

describe('gemini', () => {
  const common = () => ({ session_id: 'g1', cwd: root, transcript_path: '', timestamp: '2026-10-19T12:00:00Z' })

  test('denies a replace that weakens checks, always answering JSON', () => {
    const reply = hook('gemini', 'BeforeTool', {
      ...common(),
      tool_name: 'replace',
      tool_input: { file_path: join(root, 'src/a.test.ts'), old_string: "it('x'", new_string: "it.skip('x'" },
    })
    assert.equal(reply.json?.decision, 'deny')
    assert.match(String(reply.json?.reason), /skips or isolates tests/)
    assert.deepEqual(hook('gemini', 'BeforeTool', { ...common(), tool_name: 'read_file', tool_input: {} }).json, {})
  })

  test('returns the handoff on the next BeforeAgent after PreCompress', () => {
    hook('gemini', 'BeforeAgent', { ...common(), prompt: 'Refactor billing.' })
    hook('gemini', 'PreCompress', { ...common(), trigger: 'auto' })
    const reply = hook('gemini', 'BeforeAgent', { ...common(), prompt: 'continue' })
    assert.match((reply.json?.hookSpecificOutput as Record<string, string>).additionalContext ?? '', /Refactor billing\./)
  })

  test('retries on AfterAgent when checks fail', () => {
    hook('gemini', 'BeforeTool', { ...common(), tool_name: 'write_file', tool_input: { file_path: 'src/c.ts', content: 'export {}' } })
    assert.equal(hook('gemini', 'AfterAgent', { ...common(), stop_hook_active: false }).json?.decision, 'block')
  })
})

describe('cursor', () => {
  const common = () => ({ conversation_id: 'k1', workspace_roots: [root], hook_event_name: 'x' })

  test('denies a destructive shell command with permission deny', () => {
    const reply = hook('cursor', 'beforeShellExecution', { ...common(), command: 'git reset --hard', cwd: root })
    assert.equal(reply.json?.permission, 'deny')
    assert.match(String(reply.json?.agent_message), /destroys uncommitted work/)
  })

  test('makes no decision on an allowed command so Cursor still asks as usual', () => {
    assert.deepEqual(hook('cursor', 'beforeShellExecution', { ...common(), command: 'ls', cwd: root }).json, {})
  })

  test('sends a follow-up on stop after an edit when checks fail', () => {
    hook('cursor', 'afterFileEdit', { ...common(), file_path: join(root, 'src/d.ts'), edits: [] })
    assert.match(String(hook('cursor', 'stop', { ...common(), status: 'completed', loop_count: 0 }).json?.followup_message), /lint broke/)
  })
})

describe('copilot', () => {
  const common = () => ({ sessionId: 'p1', cwd: root, timestamp: 1 })

  test('denies a destructive bash command given toolArgs as a JSON string', () => {
    const reply = hook('copilot', 'preToolUse', { ...common(), toolName: 'bash', toolArgs: JSON.stringify({ command: 'git clean -fdx' }) })
    assert.equal(reply.json?.permissionDecision, 'deny')
  })

  test('blocks an out-of-scope create and lets an unrecognised edit through', () => {
    const blocked = hook('copilot', 'preToolUse', { ...common(), toolName: 'create', toolArgs: { path: 'infra/main.tf', file_text: 'x' } })
    assert.match(String(blocked.json?.permissionDecisionReason), /outside the scope/)
    assert.equal(hook('copilot', 'preToolUse', { ...common(), toolName: 'edit', toolArgs: { unknown: 1 } }).stdout, '')
  })

  test('blocks agentStop when checks fail after an edit', () => {
    hook('copilot', 'preToolUse', { ...common(), toolName: 'edit', toolArgs: { path: 'src/e.ts', old_str: 'a', new_str: 'b' } })
    assert.equal(hook('copilot', 'agentStop', { ...common(), stop_hook_active: false }).json?.decision, 'block')
  })
})

test('fails open on garbage input', () => {
  const ran = spawnSync(process.execPath, [MAIN, 'codex', 'PreToolUse'], { input: '{not json', encoding: 'utf8', env })
  assert.equal(ran.status, 0)
  assert.equal(ran.stdout, '')
})

test('parses add, update, move and delete hunks from a Codex patch', () => {
  const edits = parsePatch(
    ['*** Begin Patch', '*** Add File: a.ts', '+new', '*** Update File: b.ts', '*** Move to: c.ts', '@@', '-old', '+fresh', '*** Delete File: d.ts', '*** End Patch'].join('\n'),
  )
  assert.deepEqual(edits, [
    { path: 'a.ts', newText: 'new', oldText: '' },
    { path: 'b.ts', newText: '', oldText: '' },
    { path: 'c.ts', newText: 'fresh', oldText: 'old' },
    { path: 'd.ts', newText: '', oldText: '' },
  ])
})

describe('payload capture', () => {
  const payloads = () => join(env.CLAUDE_MODS_HOME ?? '', 'payloads.log')
  const toolArgs = JSON.stringify({ path: 'src/a.ts', file_text: 'x'.repeat(500) })

  test('is off by default', () => {
    hook('copilot', 'preToolUse', { sessionId: 'p1', cwd: root, toolName: 'create', toolArgs })
    assert.equal(existsSync(payloads()), false)
  })

  test('CLAUDE_MODS_DEBUG=1 logs tool, event, keys and truncated values', () => {
    env.CLAUDE_MODS_DEBUG = '1'
    hook('copilot', 'preToolUse', { sessionId: 'p1', cwd: root, toolName: 'create', toolArgs })
    const entry = JSON.parse(readFileSync(payloads(), 'utf8').trim()) as Record<string, any>
    assert.equal(entry.tool, 'copilot')
    assert.equal(entry.event, 'preToolUse')
    assert.deepEqual(entry.keys, ['sessionId', 'cwd', 'toolName', 'toolArgs'])
    assert.deepEqual(entry.argumentKeys, ['path', 'file_text'])
    assert.match(entry.payload.toolArgs.file_text, /^x{200}… \(500 chars\)$/)
  })

  test('"debug": true in config.json turns it on too', () => {
    mkdirSync(env.CLAUDE_MODS_HOME ?? '', { recursive: true })
    writeFileSync(join(env.CLAUDE_MODS_HOME ?? '', 'config.json'), JSON.stringify({ debug: true }))
    hook('cursor', 'preToolUse', { conversation_id: 'k', workspace_roots: [root], tool_name: 'Write', tool_input: { target: 'a' } })
    assert.match(readFileSync(payloads(), 'utf8'), /"argumentKeys":\["target"\]/)
  })
})
