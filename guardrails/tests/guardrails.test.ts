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
  setTree: (diff: string | undefined) => void
  setGit: (answers: Record<string, string>) => void
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
  // Not a git repo unless a test sets a working tree; then the fingerprint follows `tree`.
  let tree: string | undefined
  let gitAnswers: Record<string, string> = {}
  const git = (args: readonly string[]) => {
    const answer = gitAnswers[args.join(' ')]
    if (answer !== undefined) return { value: { exitCode: 0, stdout: answer, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const isRepo = tree !== undefined
    const stdout = args[0] === 'diff' ? (tree ?? '') : args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}' ? 'abc' : ''
    return { value: { exitCode: isRepo ? 0 : 128, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
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
    if (e.argv[0] === 'git') return git(e.argv.slice(1))
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
    setTree: diff => {
      tree = diff
    },
    setGit: answers => {
      gitAnswers = answers
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

const CAMERA = (lines: number) =>
  `import { Editor } from 'tldraw'\nimport { useState } from 'react'\n${'export const step = 1\n'.repeat(lines)}`

test('holds a large new file built on a library the session never looked up, once', async ($, on) => {
  world(on, { ...BASE, [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { react: '19.0.0', tldraw: '4.0.0' } }) })
  const write = (path: string, content: string) => $.tool.call({ tool: 'Write', file_path: path, content })

  const held = await write(`${ROOT}/src/camera.tsx`, CAMERA(200))
  expect(held.deny).toContain("builds on 'tldraw'")
  expect(held.deny).not.toContain("'react'")
  expect((await write(`${ROOT}/src/camera.tsx`, CAMERA(200))).deny).toBeUndefined()
  expect((await write(`${ROOT}/src/small.tsx`, CAMERA(20))).deny).toBeUndefined()
})

test('lets the new file through once the library was searched or read', async ($, on) => {
  world(on, { ...BASE, [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { react: '19.0.0', tldraw: '4.0.0' } }) })
  await $.tool.call({ tool: 'Grep', pattern: 'setCamera', path: `${ROOT}/node_modules/tldraw/dist` })

  const written = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/camera.tsx`, content: CAMERA(200) })
  expect(written.deny).toBeUndefined()
})

test('blocks snapshot rewrites and removed assertions', async ($, on) => {
  world(on, BASE)
  expect((await $.tool.call({ tool: 'Bash', command: 'pnpm vitest run -u' })).deny).toContain('rewrites snapshots')
  const removed = await edit($, `${ROOT}/src/a.test.ts`, "it('x', () => {})", "it('x', () => { expect(a).toBe(1) })")
  expect(removed.deny).toContain('removes assertions from a test (1 → 0)')
})

test('inside a crew worktree, the ticket decides what may be edited and the stop gate is left alone', async ($, on) => {
  const tree = `${ROOT}/.claude/worktrees/02-api`
  const marker = JSON.stringify({ feature: 'orders', ticket: '02-api', owns: ['src/server/**'], shared: ['package.json', 'src/routes.ts'] })
  const { runs } = world(on, { ...BASE, [`${ROOT}/.claude/spec.md`]: SPEC, [`${tree}/.crew-ticket.json`]: marker, [`${tree}/package.json`]: PACKAGE_JSON })

  expect((await edit($, `${tree}/src/server/orders.ts`, 'export const a = 1')).deny).toBeUndefined()
  expect((await edit($, `${tree}/src/ui/a.tsx`, 'export const a = 1')).deny).toContain('not owned by ticket 02-api')
  expect((await edit($, `${tree}/src/routes.ts`, 'export const a = 1')).deny).toContain('only the crew lead edits it')

  await $.classic.Stop({})
  expect(runs).toEqual([])
})

test('checks a turn whose files changed through the shell, and holds an untrue success claim once', async ($, on) => {
  const { runs, setExit, setTree } = world(on, BASE)
  setTree('')
  await prompt($, 'Rename the helper.')
  setTree('diff --git a/src/a.ts b/src/a.ts')
  setExit('pnpm run lint', 1)

  const sentBack = await $.classic.Stop({})
  expect(sentBack.block).toContain('checks fail')
  expect(runs).toEqual(['pnpm run typecheck', 'pnpm run lint'])
})

test('holds a reply that says tests pass when the checks fail, once per turn', async ($, on) => {
  const { setExit } = world(on, BASE)
  setExit('pnpm run lint', 1)
  await prompt($, 'Is the build green?')

  const held = await $.classic.Stop({ last_assistant_message: 'Yes, all green.' })
  expect(held.block).toContain('your reply says "all green", but the checks fail')
  const again = await $.classic.Stop({ last_assistant_message: 'Yes, all green.' })
  expect(again.block).toBeUndefined()
})

test('runs only changed tests at the end of a turn and records the block for doctor', async ($, on) => {
  const vitest = JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc', test: 'vitest' }, dependencies: { react: '19.0.0' } })
  const { runs, files } = world(on, { ...BASE, [`${ROOT}/package.json`]: vitest })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }))

  await edit($, `${ROOT}/src/a.ts`, 'export const a = 1')
  await $.classic.Stop({})
  expect(runs).toEqual(['pnpm run typecheck', 'pnpm exec vitest run --changed'])

  await $.tool.call({ tool: 'Bash', command: 'git push --force' })
  expect(files.get('/home/dev/.claude-mods/blocks.log')).toContain('"rule":"command"')
})

test('judges what the whole turn changed, so a test deleted or skipped through the shell is caught once', async ($, on) => {
  const { files, setTree, setGit } = world(on, BASE)
  setTree('')
  setGit({ 'stash create': 'base1' })
  await prompt($, 'Clean up the tests.')

  setGit({ 'stash create': 'base1', 'diff --name-status -M base1': 'D\tsrc/old.test.ts\nM\tsrc/a.test.ts\n', 'show base1:src/a.test.ts': "it('a', () => { expect(1).toBe(1) })" })
  files.set(`${ROOT}/src/a.test.ts`, "it('a', () => { expect(1).toBe(1) })")
  const caught = await $.classic.Stop({})
  expect(caught.block).toContain('this turn deletes the test file src/old.test.ts')
  expect((await $.classic.Stop({})).block ?? '').not.toContain('this turn')
})

test('runs the end-of-turn checks in the background after edits and reuses the result when the turn ends', async ($, on) => {
  const vitest = JSON.stringify({ name: 'app', scripts: { test: 'vitest' }, dependencies: { react: '19.0.0' } })
  const { clock, runs, setTree } = world(on, { ...BASE, [`${ROOT}/package.json`]: vitest })
  setTree('')

  await edit($, `${ROOT}/src/a.ts`, 'export const a = 1')
  await edit($, `${ROOT}/src/a.ts`, 'export const a = 2')
  await clock.advance(1_500)
  await clock.advance(10)
  expect(runs).toEqual(['pnpm exec vitest run --changed'])

  await $.classic.Stop({})
  expect(runs).toEqual(['pnpm exec vitest run --changed'])
})

test('ignores a background result for an older tree and runs the checks at the end of the turn', async ($, on) => {
  const vitest = JSON.stringify({ name: 'app', scripts: { test: 'vitest' }, dependencies: { react: '19.0.0' } })
  const { clock, runs, setTree } = world(on, { ...BASE, [`${ROOT}/package.json`]: vitest })
  setTree('')
  await edit($, `${ROOT}/src/a.ts`, 'export const a = 1')
  await clock.advance(1_510)
  setTree('diff --git a/src/b.ts b/src/b.ts')

  await $.classic.Stop({})
  expect(runs).toEqual(['pnpm exec vitest run --changed', 'pnpm exec vitest run --changed'])
})
