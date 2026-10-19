import type { On } from 'claude-code'
import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

const ROOT = '/work/app'

type World = {
  clock: MockClock
  files: Map<string, string>
  runs: string[]
  submitted: string[]
  logs: string[]
  toasts: string[]
  setExit: (label: string, exitCode: number) => void
  setPercent: (percent: number) => void
}

const world = (on: On, initial: Record<string, string> = {}): World => {
  const files = new Map<string, string>(Object.entries(initial))
  const exits = new Map<string, number>()
  const runs: string[] = []
  const submitted: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  let percent = 20

  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200_000, percent } } }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    return text === undefined ? { deny: 'ENOENT' } : { value: text }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(`${ROOT}/`) && !path.slice(ROOT.length + 1).includes('/'))
      .map(path => ({ name: path.slice(ROOT.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    const label = e.argv.join(' ')
    runs.push(label)
    const exitCode = exits.get(label) ?? 0
    return {
      value: { exitCode, stdout: exitCode === 0 ? 'ok' : `error in ${label}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: null, text: 'done' }))
  on('classic.Stop', () => ({}))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })

  return {
    clock,
    files,
    runs,
    submitted,
    logs,
    toasts,
    setExit: (label, exitCode) => {
      exits.set(label, exitCode)
    },
    setPercent: next => {
      percent = next
    },
  }
}

const PACKAGE_JSON = JSON.stringify({
  name: 'app',
  scripts: { typecheck: 'tsc', lint: 'eslint .' },
  dependencies: { react: '19.0.0' },
})

const BASE = { [`${ROOT}/package.json`]: PACKAGE_JSON, [`${ROOT}/pnpm-lock.yaml`]: '' }

const SPEC = '---\nscope: [src/auth/**]\nchecks: [pnpm test auth]\n---\nAdd OAuth login.'

const edit = ($: Engine, file_path: string, new_string: string, old_string = 'x') =>
  $.tool.call({ tool: 'Edit', file_path, old_string, new_string })

const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('blocks edits outside the spec scope and points at Suggestions', async ($, on) => {
  world(on, { ...BASE, [`${ROOT}/.claude/spec.md`]: SPEC })

  const outside = await edit($, `${ROOT}/src/billing/pay.ts`, 'const a = 1')
  const inside = await edit($, `${ROOT}/src/auth/login.ts`, 'const a = 1')

  expect(outside.deny).toContain('src/billing/pay.ts is outside the scope in .claude/spec.md')
  expect(outside.deny).toContain('Suggestions:')
  expect(inside.deny).toBeUndefined()
})

test('blocks imports of packages that are neither installed nor declared', async ($, on) => {
  world(on, { ...BASE, [`${ROOT}/node_modules/zod/package.json`]: '{}' })

  const madeUp = await edit($, `${ROOT}/src/a.ts`, "import { magic } from 'react-magic-hooks'")
  const declared = await edit($, `${ROOT}/src/b.ts`, "import { use } from 'react'")
  const installed = await edit($, `${ROOT}/src/c.ts`, "import { z } from 'zod'")

  expect(madeUp.deny).toContain("'react-magic-hooks' is not installed or declared")
  expect(declared.deny).toBeUndefined()
  expect(installed.deny).toBeUndefined()
})

test('blocks check-weakening edits and hand-edited lockfiles', async ($, on) => {
  world(on, BASE)

  expect((await edit($, `${ROOT}/src/a.test.ts`, "it.only('x', () => {})")).deny).toContain('skips or isolates tests')
  expect((await edit($, `${ROOT}/pnpm-lock.yaml`, 'lockfileVersion: 9')).deny).toContain("don't hand-edit pnpm-lock.yaml")
})

test('blocks destructive git and gates commits on checks', async ($, on) => {
  const { runs, setExit } = world(on, BASE)

  expect((await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })).deny).toContain('destroys uncommitted work')

  setExit('pnpm run lint', 1)
  const blocked = await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })
  expect(blocked.deny).toContain('commit blocked, checks fail')
  expect(blocked.deny).toContain('✗ pnpm run lint (exit 1)')
  expect(runs).toEqual(['pnpm run typecheck', 'pnpm run lint'])

  setExit('pnpm run lint', 0)
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: x"' })).deny).toBeUndefined()
})

test('sends Claude back when checks fail after edits, then gives up after two retries', async ($, on) => {
  const { setExit, logs } = world(on, { ...BASE, [`${ROOT}/.claude/spec.md`]: SPEC })

  await edit($, `${ROOT}/src/auth/login.ts`, 'const a = 1')
  setExit('pnpm test auth', 1)

  expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('retry 1/2')
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toContain('retry 2/2')
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
  expect(logs.at(-1)).toContain('checks still fail after 2 retries')
})

test('lets Claude finish when nothing was edited', async ($, on) => {
  const { runs } = world(on, BASE)

  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
  expect(runs).toHaveLength(0)
})

test('/ship runs checks and only then queues the ship prompt', async ($, on) => {
  const { submitted, setExit, clock } = world(on, BASE)
  const run = (command: string) =>
    $.command.run({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  setExit('pnpm run typecheck', 2)
  expect((await run('ship')).text).toContain('not shipping, checks fail')
  expect(submitted).toHaveLength(0)

  setExit('pnpm run typecheck', 0)
  expect((await run('ship')).text).toContain('✓ checks pass, shipping')
  await clock.advance(200)
  expect(submitted.at(-1)).toContain('open a draft PR')
})

test('holds a long new task at high context once, then lets the resend through', async ($, on) => {
  const { setPercent } = world(on, BASE)
  const task = `Refactor the whole billing module. ${'details '.repeat(60)}`

  setPercent(81)
  const first = await prompt($, task)
  const second = await prompt($, task)

  expect(first.drop).toContain('context is at 81%')
  expect(second.text).toBe(task)
})

test('saves a long pasted prompt as a spec draft when none exists', async ($, on) => {
  const { files, toasts } = world(on, BASE)
  const pasted = `Build me the skeleton of a 24/7 AI trading desk. ${'requirement '.repeat(150)}`

  await prompt($, pasted)

  expect(files.get(`${ROOT}/.claude/spec.md`)).toContain('scope: []')
  expect(files.get(`${ROOT}/.claude/spec.md`)).toContain('24/7 AI trading desk')
  expect(toasts.at(-1)).toContain('Saved your long prompt as .claude/spec.md')
})
