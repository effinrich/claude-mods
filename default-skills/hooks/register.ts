import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { clipSkill, newestVersion, parseSkillList, renderSkill, skillLabel, type SkillRef } from './skills.ts'

type Loaded = { label: string; text: string; path: string; isClipped: boolean }
type Missing = { label: string }
type LoadResult = { loaded: readonly Loaded[]; missing: readonly Missing[] }

const DEFAULT_SKILLS = 'ponytail:ponytail full, feature-based-architecture, default-skills:plain-writing'

let cache: LoadResult | undefined

const readSkills = (options: PluginOptions): SkillRef[] =>
  parseSkillList(typeof options.skills === 'string' ? options.skills : DEFAULT_SKILLS)

const dirNames = async ($: EngineInterface, path: string): Promise<string[]> =>
  (await $.fs.list(path).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)

// Plugin skills live at ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md.
const findPluginSkill = async ($: EngineInterface, home: string, ref: SkillRef & { plugin: string }) => {
  const cacheRoot = `${home}/.claude/plugins/cache`
  for (const marketplace of await dirNames($, cacheRoot)) {
    const pluginDir = `${cacheRoot}/${marketplace}/${ref.plugin}`
    const version = newestVersion(await dirNames($, pluginDir))
    if (version === undefined) continue
    const root = `${pluginDir}/${version}`
    const skillDir = `${root}/skills/${ref.skill}`
    if (await $.fs.exists(`${skillDir}/SKILL.md`)) return { skillDir, pluginRoot: root }
  }
  return undefined
}

const findSkill = async ($: EngineInterface, home: string | undefined, root: string, ref: SkillRef) => {
  if (ref.plugin !== undefined) {
    return home === undefined ? undefined : findPluginSkill($, home, { ...ref, plugin: ref.plugin })
  }
  // Skills synced from a claude.ai account sit one level down, in ~/.claude/skills/synced/<id>/.
  const synced = home === undefined ? [] : (await dirNames($, `${home}/.claude/skills/synced`)).map(id => `${home}/.claude/skills/synced/${id}`)
  for (const base of [`${root}/.claude/skills`, ...(home === undefined ? [] : [`${home}/.claude/skills`]), ...synced]) {
    const skillDir = `${base}/${ref.skill}`
    if (await $.fs.exists(`${skillDir}/SKILL.md`)) return { skillDir, pluginRoot: undefined }
  }
  return undefined
}

const loadSkills = async ($: EngineInterface, refs: readonly SkillRef[]): Promise<LoadResult> => {
  const [home, root] = await Promise.all([
    $.env.get('HOME').then(value => value ?? $.env.get('USERPROFILE')),
    $.session.root(),
  ])
  const loaded: Loaded[] = []
  const missing: Missing[] = []
  for (const ref of refs) {
    const found = await findSkill($, home, root, ref)
    const fileText = found === undefined ? undefined : await $.fs.read(`${found.skillDir}/SKILL.md`).catch(() => undefined)
    if (found === undefined || typeof fileText !== 'string') {
      missing.push({ label: skillLabel(ref) })
      continue
    }
    const { text, isClipped } = clipSkill(renderSkill(fileText, ref, found.skillDir, found.pluginRoot))
    loaded.push({ label: skillLabel(ref), text, path: `${found.skillDir}/SKILL.md`, isClipped })
  }
  return { loaded, missing }
}

const ensureLoaded = async ($: EngineInterface, refs: readonly SkillRef[]): Promise<LoadResult> => {
  cache ??= await loadSkills($, refs)
  return cache
}

const TOKEN_WARNING = 2000

const pinnedTokens = (result: LoadResult): number => result.loaded.reduce((sum, skill) => sum + Math.round(skill.text.length / 4), 0)

const describe = (result: LoadResult): string => {
  const lines = result.loaded.map(
    skill => `✓ ${skill.label}: ~${Math.round(skill.text.length / 4)} tokens${skill.isClipped ? ' (cut to fit)' : ''} from ${skill.path}`,
  )
  lines.push(...result.missing.map(skill => `✗ ${skill.label}: not found (is the plugin installed?)`))
  if (lines.length === 0) return 'No default skills configured.'
  const total = pinnedTokens(result)
  lines.push(`total: ~${total} tokens with every turn${total > TOKEN_WARNING ? `. Over ~${TOKEN_WARNING}: consider dropping or shortening one in /config.` : ''}`)
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const refs = readSkills(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'default-skills', description: 'Show which skills are pinned into every turn.' })
    const loaded = await ensureLoaded($, refs)
    if (loaded.missing.length > 0) {
      $.ui.toast(`default-skills: ${loaded.missing.map(skill => skill.label).join(', ')} not found.`, { timeoutMs: 8_000 })
    }
    if (pinnedTokens(loaded) > TOKEN_WARNING) {
      $.ui.toast(`default-skills: pinned skills add ~${pinnedTokens(loaded)} tokens to every turn. /default-skills shows each one.`, { timeoutMs: 8_000 })
    }
    $.ui.status(loaded.loaded.length === 0 ? undefined : `skills: ${loaded.loaded.map(skill => skill.label).join(', ')}`)
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const { loaded } = await ensureLoaded($, refs)
    const sections = loaded.map(skill => ({
      id: `default-skills:${skill.label}`,
      text: `Active by default (as if /${skill.label} were run at session start; stays on through compaction):\n\n${skill.text}`,
      scope: 'session' as const,
    }))
    return sections.length === 0 ? result : { ...result, sections: [...result.sections, ...sections] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'default-skills' }, async $ => {
    cache = undefined
    return { text: describe(await ensureLoaded($, refs)) }
  })
}
