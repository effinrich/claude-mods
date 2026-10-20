import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { frontier, judgeOwnership, mayOverlap, parsePlan, parseTicket, validateGraph } from '../../core/crew.ts'
import { runCrew } from '../crew.ts'
import { decide } from '../engine.ts'
import { DEFAULT_CONFIG } from '../types.ts'

const ticket = (id: string, fields: string, body = `# ${id}`) => parseTicket(id, `---\n${fields}\n---\n${body}`)

describe('crew graph', () => {
  const plan = parsePlan('---\ngoal: orders\nshared: [src/routes.ts]\ncap: 2\n---\n')
  const types = ticket('01-types', 'role: backend\nowns: [src/shared/order.ts]')
  const api = ticket('02-api', 'role: backend\nowns: [src/server/**]\nblockedBy: [01-types]')
  const ui = ticket('03-ui', 'role: frontend\nowns: [src/ui/orders/**]\nblockedBy: [01-types]')
  const docs = ticket('04-docs', 'role: docs\nowns: [docs/orders.md]\nblockedBy: [02-api, 03-ui]')

  test('reads tickets and the plan, with shared defaults and the cap', () => {
    assert.deepEqual(api.blockedBy, ['01-types'])
    assert.equal(api.title, '02-api')
    assert.equal(plan.cap, 2)
    assert.ok(plan.shared.includes('package.json') && plan.shared.includes('src/routes.ts'))
  })

  test('validates roles, owners, blockers, cycles and shared files', () => {
    assert.deepEqual(validateGraph([types, api, ui, docs], plan).errors, [])
    const bad = [
      ticket('a', 'role: wizard\nowns: [x/**]'),
      ticket('b', 'role: backend\nowns: [package.json]\nblockedBy: [c]'),
      ticket('c', 'role: backend\nowns: [y/**]\nblockedBy: [b]'),
      ticket('d', 'role: backend\nblockedBy: [nope]'),
    ]
    const { errors } = validateGraph(bad, plan)
    assert.ok(errors.some(error => error.startsWith('a: role must be')))
    assert.ok(errors.some(error => error.includes('owns shared files (package.json)')))
    assert.ok(errors.some(error => error.startsWith('blockedBy cycle')))
    assert.ok(errors.some(error => error === 'd: owns is empty'))
    assert.ok(errors.some(error => error.includes('blockedBy nope')))
  })

  test('warns about unordered tickets that may share files', () => {
    const left = ticket('x', 'role: backend\nowns: [src/server/**]')
    const right = ticket('y', 'role: backend\nowns: [src/server/orders.ts]')
    assert.match(validateGraph([left, right], plan).warnings[0] ?? '', /x and y may touch the same files/)
    assert.equal(mayOverlap(['src/ui/**'], ['src/server/**']), false)
    assert.equal(mayOverlap(['src/*.ts'], ['src/a.ts']), true)
  })

  test('starts only unblocked, non-overlapping tickets within the cap', () => {
    assert.deepEqual(frontier([types, api, ui, docs], {}, 8).map(t => t.id), ['01-types'])
    assert.deepEqual(frontier([types, api, ui, docs], { '01-types': 'merged' }, 8).map(t => t.id), ['02-api', '03-ui'])
    assert.deepEqual(frontier([types, api, ui, docs], { '01-types': 'merged' }, 1).map(t => t.id), ['02-api'])
    assert.deepEqual(frontier([types, api, ui, docs], { '01-types': 'merged', '02-api': 'running' }, 2).map(t => t.id), ['03-ui'])
  })

  test('judges ownership, shared files first', () => {
    const marker = { feature: 'f', ticket: '02-api', owns: ['src/server/**'], shared: plan.shared }
    assert.equal(judgeOwnership('src/server/orders.ts', marker), undefined)
    assert.match(judgeOwnership('src/routes.ts', marker) ?? '', /shared, so only the crew lead edits it/)
    assert.match(judgeOwnership('src/ui/a.tsx', marker) ?? '', /not owned by ticket 02-api/)
  })
})

describe('crew run', () => {
  let repo = ''
  let lines: string[] = []
  const crew = (cwd: string, ...args: string[]) => {
    lines = []
    return runCrew(args, cwd, line => lines.push(line))
  }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const put = (base: string, path: string, text: string) => {
    mkdirSync(dirname(join(base, path)), { recursive: true })
    writeFileSync(join(base, path), text)
  }
  // What Claude Code does for an isolated subagent with worktree.baseRef "head".
  const spawnWorktree = (id: string): string => {
    const path = join(repo, '.claude', 'worktrees', id)
    git(repo, 'worktree', 'add', '-b', `worktree-${id}`, path, 'HEAD')
    return path
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'claude-mods-crew-'))
    repo = join(base, 'repo')
    process.env.HOME = join(base, 'home')
    process.env.CLAUDE_MODS_HOME = join(base, 'mods')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 'dev@example.com')
    git(repo, 'config', 'user.name', 'Dev')
    put(repo, 'README.md', '# app\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'init')
    put(repo, '.claude/crew/orders/plan.md', '---\ngoal: orders\nsetup: none\ncap: 4\n---\nOrders feature.\n')
    put(repo, '.claude/crew/orders/tickets/01-types.md', '---\nrole: backend\nowns: [src/shared/**]\nchecks: [node --version]\n---\n# Order types\n')
    put(repo, '.claude/crew/orders/tickets/02-api.md', '---\nrole: backend\nowns: [src/server/**]\nblockedBy: [01-types]\nchecks: [node --version]\n---\n# Orders API\n')
    put(repo, '.claude/crew/orders/tickets/03-ui.md', '---\nrole: frontend\nowns: [src/ui/**]\nblockedBy: [01-types]\nchecks: [node --version]\n---\n# Orders UI\n')
  })

  test('runs tickets in waves, merges them into one branch and enforces ownership', async () => {
    assert.equal(crew(repo, 'init', 'orders'), 0, lines.join('\n'))
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'crew/orders')
    assert.equal(JSON.parse(readFileSync(join(repo, '.claude/settings.local.json'), 'utf8')).worktree.baseRef, 'head')

    crew(repo, 'next', 'orders')
    assert.ok(lines.some(line => line.includes('01-types')))
    assert.ok(!lines.some(line => line.includes('02-api')))

    const typesTree = spawnWorktree('01-types')
    assert.equal(crew(typesTree, 'claim', 'orders', '01-types'), 0, lines.join('\n'))
    assert.ok(lines.includes('you may edit only: src/shared/**'))
    assert.ok(existsSync(join(typesTree, '.crew-ticket.json')))
    put(typesTree, 'src/shared/order.ts', 'export type Order = { id: string }\n')
    assert.equal(crew(repo, 'merge', 'orders', '01-types'), 0, lines.join('\n'))
    assert.ok(existsSync(join(repo, 'src/shared/order.ts')))
    assert.ok(!existsSync(typesTree))

    crew(repo, 'next', 'orders')
    assert.ok(lines.some(line => line.includes('02-api')) && lines.some(line => line.includes('03-ui')))
    put(repo, '.claude/claude-mods.json', JSON.stringify({ skills: 'plain-writing', roles: { backend: 'api-style' } }))
    const apiTree = spawnWorktree('02-api')
    const uiTree = spawnWorktree('03-ui')
    assert.equal(crew(apiTree, 'claim', 'orders', '02-api'), 0, lines.join('\n'))
    assert.ok(lines.some(line => line.startsWith('skills: api-style, plain-writing')), lines.join('\n'))
    assert.equal(crew(uiTree, 'claim', 'orders', '03-ui'), 0, lines.join('\n'))

    const denied = await decide('codex', { promptContext: true }, DEFAULT_CONFIG, {
      sessionId: 's',
      cwd: apiTree,
      kind: 'edit',
      edits: [{ path: join(apiTree, 'src/ui/hack.tsx'), newText: 'x', oldText: '' }],
    }, new Date())
    assert.match(denied.kind === 'deny' ? denied.reason : '', /not owned by ticket 02-api/)

    put(apiTree, 'src/server/orders.ts', 'export const list = () => []\n')
    put(apiTree, 'package.json', '{"name":"sneaky"}\n')
    assert.equal(crew(repo, 'merge', 'orders', '02-api'), 1)
    assert.ok(lines.some(line => line.includes('package.json (shared)')), lines.join('\n'))

    git(apiTree, 'rm', '-q', 'package.json')
    git(apiTree, 'commit', '-qm', 'drop package.json')
    assert.equal(crew(apiTree, 'check', 'orders', '02-api'), 0, lines.join('\n'))
    assert.equal(crew(repo, 'merge', 'orders', '02-api'), 0, lines.join('\n'))
    put(uiTree, 'src/ui/orders.tsx', 'export const Orders = () => null\n')
    assert.equal(crew(repo, 'merge', 'orders', '03-ui'), 0, lines.join('\n'))

    crew(repo, 'status', 'orders')
    assert.ok(lines.some(line => line.startsWith('all merged')), lines.join('\n'))
    assert.equal(git(repo, 'log', '--merges', '--format=%s').split('\n').length, 3)
  })

  test('refuses a claim from a worktree that is missing a merged blocker', () => {
    crew(repo, 'init', 'orders')
    crew(repo, 'next', 'orders')
    const typesTree = spawnWorktree('01-types')
    crew(typesTree, 'claim', 'orders', '01-types')
    put(typesTree, 'src/shared/order.ts', 'export {}\n')
    crew(repo, 'merge', 'orders', '01-types')
    crew(repo, 'next', 'orders')
    const stale = join(repo, '.claude', 'worktrees', 'stale')
    git(repo, 'worktree', 'add', '-b', 'stale', stale, 'main')
    assert.equal(crew(stale, 'claim', 'orders', '02-api'), 1)
    assert.ok(lines.some(line => line.includes('does not contain 01-types')), lines.join('\n'))
  })

  test('undoes a merge whose plan checks fail', () => {
    put(repo, '.claude/crew/orders/plan.md', '---\ngoal: orders\nsetup: none\nchecks: [node -e process.exit(1)]\n---\n')
    crew(repo, 'init', 'orders')
    crew(repo, 'next', 'orders')
    const typesTree = spawnWorktree('01-types')
    crew(typesTree, 'claim', 'orders', '01-types')
    put(typesTree, 'src/shared/order.ts', 'export {}\n')
    const before = git(repo, 'rev-parse', 'HEAD')
    assert.equal(crew(repo, 'merge', 'orders', '01-types'), 1)
    assert.ok(lines.some(line => line.includes('merge was undone')), lines.join('\n'))
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
  })
})
