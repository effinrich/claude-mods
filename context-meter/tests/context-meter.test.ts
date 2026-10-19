import type { On, SessionMessage, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MESSAGES: readonly SessionMessage[] = [{ role: 'user', text: 'summary', toolUses: [] }]

type World = { statuses: (string | undefined)[]; setUsage: (usage: SessionUsage) => void }

const usage = (percent: number | undefined, extra: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: 0,
  rateLimits: [],
  context: { window: 200_000, percent, tokens: percent === undefined ? undefined : percent * 2_000 },
  cost: { usd: 3.4123 },
  ...extra,
})

const world = (on: On): World => {
  const statuses: (string | undefined)[] = []
  let current = usage(12)
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.usage', () => ({ value: current }))
  on('session.compact', () => ({ messages: MESSAGES }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return {
    statuses,
    setUsage: next => {
      current = next
    },
  }
}

test('shows context, cost and model at session start', async ($, on) => {
  const { statuses } = world(on)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(statuses.at(-1)).toBe('ctx 12% · $3.41 · opus-5-5')
})

test('marks warning and fork thresholds and counts compactions', async ($, on) => {
  const { statuses, setUsage } = world(on)

  setUsage(usage(65))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('ctx 65% ⚠ · $3.41 · opus-5-5')

  setUsage(usage(undefined))
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(statuses.at(-1)).toBe('ctx – · $3.41 · 1× compacted · opus-5-5')

  setUsage(usage(84, { rateLimits: [{ kind: '5h', percentUsed: 71.6 }] }))
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  expect(statuses.at(-1)).toBe('ctx 84% ⛔ fork soon · $3.41 · 2× compacted · 5h 72% · opus-5-5')
})

test('ignores subagent compactions', async ($, on) => {
  const { statuses } = world(on)

  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: MESSAGES })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect(statuses.at(-1)).not.toContain('compacted')
})
