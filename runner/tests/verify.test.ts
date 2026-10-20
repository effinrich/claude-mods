import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { resolveChecks } from '../../core/checks.ts'
import { claimedSuccess } from '../../core/rules.ts'
import { decide } from '../engine.ts'
import { DEFAULT_CONFIG, type HookEvent } from '../types.ts'

let root = ''

const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const scripts = (values: Record<string, string>) => put('package.json', JSON.stringify({ name: 'app', scripts: values }))
const pass = 'node -e "process.exit(0)"'
const failWith = (text: string) => `node -e "console.error('${text}');process.exit(1)"`
const run = (event: HookEvent) => decide('codex', { promptContext: true }, DEFAULT_CONFIG, event, new Date())
const base = () => ({ sessionId: 's1', cwd: root })
const prompt = () => run({ ...base(), kind: 'prompt', text: 'go' })
const stop = (lastMessage?: string) => run({ ...base(), kind: 'stop', isRepeat: false, lastMessage })
const reason = (verdict: Awaited<ReturnType<typeof run>>) => (verdict.kind === 'continue' || verdict.kind === 'deny' ? verdict.reason : verdict.kind === 'notice' ? verdict.text : '')

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mods-verify-'))
  root = join(dir, 'app')
  process.env.CLAUDE_MODS_HOME = join(dir, 'mods')
  process.env.HOME = join(dir, 'home')
  mkdirSync(root, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  scripts({ typecheck: pass, test: failWith('1 test failed') })
  put('src/a.ts', 'export const a = 1\n')
  git('add', '.')
  git('commit', '-qm', 'init')
})

test('runs the test script by default and skips npm init\'s placeholder', () => {
  const labels = (values: Record<string, string>) => resolveChecks([], JSON.stringify({ scripts: values }), new Set()).map(check => check.label)
  assert.deepEqual(labels({ typecheck: 'tsc', lint: 'eslint .', test: 'vitest' }), ['npm run typecheck', 'npm run lint', 'npm run test'])
  assert.deepEqual(labels({ test: 'echo "Error: no test specified" && exit 1' }), [])
})

test('a shell edit the hooks never saw still triggers the end-of-turn checks', async () => {
  await prompt()
  put('src/a.ts', 'export const a = 2\n')
  const verdict = await stop()
  assert.equal(verdict.kind, 'continue')
  assert.match(reason(verdict), /npm run test[\s\S]*1 test failed/)
})

test('a turn that changed nothing is not checked', async () => {
  await prompt()
  assert.equal((await stop()).kind, 'allow')
})

test('says once when a repo has no checks at all', async () => {
  scripts({})
  git('commit', '-qam', 'no scripts')
  await prompt()
  put('src/a.ts', 'export const a = 3\n')
  assert.match(reason(await stop()), /no checks to run/)
  await prompt()
  put('src/a.ts', 'export const a = 4\n')
  assert.equal((await stop()).kind, 'allow')
})

test('holds a reply that claims success against the checks, once per turn', async () => {
  await prompt()
  const held = await stop('Done. All tests pass.')
  assert.equal(held.kind, 'continue')
  assert.match(reason(held), /your reply says "All tests pass", but the checks fail/)
  assert.equal((await stop('All tests pass.')).kind, 'allow')

  await prompt()
  assert.equal((await stop('I could not verify the fix; the suite still fails.')).kind, 'allow')

  scripts({ typecheck: pass, test: pass })
  git('commit', '-qam', 'green')
  await prompt()
  assert.equal((await stop('Fixed, and tests pass.')).kind, 'allow')
})

test('a commit after a shell edit re-runs checks that passed before', async () => {
  scripts({ test: pass })
  git('commit', '-qam', 'green')
  await prompt()
  assert.equal((await run({ ...base(), kind: 'shell', command: 'git commit -m "first"' })).kind, 'allow')
  scripts({ test: failWith('broke') })
  const blocked = await run({ ...base(), kind: 'shell', command: 'git commit -m "second"' })
  assert.match(reason(blocked), /commit blocked[\s\S]*broke/)
})

test('finds success claims but not negated ones', () => {
  assert.equal(claimedSuccess('All green, shipping it.'), 'All green')
  assert.equal(claimedSuccess('Tests are passing now'), 'Tests are passing')
  assert.equal(claimedSuccess("I haven't verified this"), undefined)
  assert.equal(claimedSuccess('The tests did not pass'), undefined)
  assert.equal(claimedSuccess('Here is the plan for the login page.'), undefined)
})
