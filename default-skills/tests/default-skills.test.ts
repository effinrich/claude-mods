import type { FsEntry, On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'
import { newestVersion, parseSkillList } from '../hooks/skills.ts'

const HOME = '/Users/rich'
const ROOT = '/work/app'
const CACHE = `${HOME}/.claude/plugins/cache`

const SKILL_FILE = '---\nname: ponytail\ndescription: style\n---\nMode: $ARGUMENTS. Scripts in ${CLAUDE_PLUGIN_ROOT}/bin.'

type World = { toasts: string[]; statuses: (string | undefined)[] }

const world = (on: On, files: Record<string, string>): World => {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const paths = Object.keys(files)
  mock.env(on, { HOME })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', ($, e) => ({ value: paths.includes(e.path) }))
  on('fs.read', ($, e) => (files[e.path] === undefined ? { deny: 'ENOENT' } : { value: files[e.path] ?? '' }))
  on('fs.list', ($, e) => {
    const names = new Set(
      paths.filter(path => path.startsWith(`${e.path}/`)).map(path => path.slice(e.path.length + 1).split('/')[0] ?? ''),
    )
    const entries: FsEntry[] = [...names].map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'base', scope: 'shared' }] }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  return { toasts, statuses }
}

const compose = ($: Engine) =>
  $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })

test('parses plugin skills, plain skills and arguments', () => {
  expect(parseSkillList('ponytail:ponytail full, my-style')).toEqual([
    { plugin: 'ponytail', skill: 'ponytail', args: 'full' },
    { plugin: undefined, skill: 'my-style', args: '' },
  ])
  expect(newestVersion(['4.9.2', '4.10.0', '4.2.11'])).toBe('4.10.0')
})

test('pins the newest installed ponytail into the system prompt with its arguments filled in', async ($, on) => {
  const { statuses } = world(on, {
    [`${CACHE}/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md`]: 'old version',
    [`${CACHE}/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md`]: SKILL_FILE,
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const { sections } = await compose($)

  const pinned = sections.find(section => section.id === 'default-skills:ponytail:ponytail full')
  expect(pinned?.text).toContain('Mode: full.')
  expect(pinned?.text).toContain(`${CACHE}/ponytail/ponytail/4.10.0/bin`)
  expect(pinned?.text).not.toContain('name: ponytail')
  expect(pinned?.text).not.toContain('old version')
  expect(statuses.at(-1)).toBe('skills: ponytail:ponytail full')
})

test('finds project skills and says which configured skills are missing', { options: { skills: 'house-style, ghost:gone' } }, async ($, on) => {
  const { toasts } = world(on, { [`${ROOT}/.claude/skills/house-style/SKILL.md`]: 'Prefer composition.' })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const { sections } = await compose($)

  expect(sections.some(section => section.text.includes('Prefer composition.'))).toBe(true)
  expect(toasts.at(-1)).toContain('ghost:gone not found')
})

test('finds a skill synced from the claude.ai account', { options: { skills: 'feature-based-architecture' } }, async ($, on) => {
  world(on, { [`${HOME}/.claude/skills/synced/acct-1/feature-based-architecture/SKILL.md`]: '---\nname: feature-based-architecture\n---\nOrganize by feature.' })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const { sections } = await compose($)

  expect(sections.some(section => section.text.includes('Organize by feature.'))).toBe(true)
})
