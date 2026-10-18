import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

const ROOT = '/work/app'
const HANDOFF = /^\/home\/rich\/\.claude\/handoffs\/app-[0-9a-f]{6}\.md$/

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const TRANSCRIPT: readonly SessionMessage[] = [
  user('Build me the skeleton of a 24/7 AI trading desk. Paper trading only.'),
  {
    role: 'assistant',
    text: 'Planning.',
    toolUses: [
      { tool_use_id: 't1', tool: 'ExitPlanMode', input: { plan: '1. scaffold desk\n2. add risk agent' } },
      {
        tool_use_id: 't2',
        tool: 'TodoWrite',
        input: { todos: [{ content: 'scaffold desk', status: 'in_progress' }] },
      },
      { tool_use_id: 't3', tool: 'Write', input: { file_path: `${ROOT}/desk/main.py` } },
    ],
  },
  user('continue.'),
]

type World = { files: Map<string, string>; toasts: string[]; logs: string[]; handoff: () => string | undefined }

const world = (on: On): World => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const logs: string[] = []
  mock.store(on)
  mock.env(on, { HOME: '/home/rich' })
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('session.compact', ($, e) => {
    if (e.agentId === undefined) expect(e.instructions).toContain('Keep the current plan')
    return { messages: [user('This session is being continued from a previous conversation. Summary.')] }
  })
  const handoff = (): string | undefined => [...files].find(([path]) => HANDOFF.test(path))?.[1]
  return { files, toasts, logs, handoff }
}

const loadHandoff = ($: Engine) =>
  $.command.run({
    command: 'handoff-load',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

test('writes the handoff outside the repo before compacting and re-attaches it after', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { files, handoff } = world(on)

  const result = await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

  expect([...files.keys()].every(path => !path.startsWith(ROOT))).toBe(true)
  expect(handoff()).toContain('24/7 AI trading desk')
  expect(handoff()).toContain('2. add risk agent')
  expect(handoff()).toContain('[in_progress] scaffold desk')
  expect(handoff()).toContain(`${ROOT}/desk/main.py`)
  expect(result.messages?.at(-1)?.text).toContain('<handoff source="compaction-guard"')
})

test('keeps the original task once the first prompt has been summarized away', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { handoff } = world(on)

  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  await $.session.compact({
    trigger: 'auto',
    messages: [user('This session is being continued from a previous conversation. Summary.'), user('next step')],
  })

  expect(handoff()).toContain('24/7 AI trading desk')
  expect(handoff()).toContain('next step')
})

test('warns once compactions pile up inside the window', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { toasts, logs } = world(on)

  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  await clock.advance(30_000)
  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  expect(toasts).toHaveLength(0)
  await clock.advance(30_000)
  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })

  expect(toasts.at(-1)).toContain('3 compactions in 1 min')
  expect(logs.at(-1)).toContain('/handoff-load')
})

test('leaves subagent compactions alone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { files } = world(on)

  await $.session.compact({ trigger: 'auto', agentId: 'agent-7', messages: TRANSCRIPT })

  expect(files.size).toBe(0)
})

test('/handoff-load hands the saved handoff to the model', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  world(on)

  const before = await loadHandoff($)
  expect(before.text).toContain('No handoff saved for this project yet')

  await $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  const after = await loadHandoff($)

  expect(after.text).toContain('Loaded the handoff')
  expect(after.context?.[0]).toContain('24/7 AI trading desk')
})
