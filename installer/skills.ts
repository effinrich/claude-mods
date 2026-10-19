import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { ToolName } from '../runner/types.ts'
import { newestVersion, parseSkillList, type SkillRef } from '../core/skills.ts'
import { readText, withBlock, type Plan } from './files.ts'
import { instructionsPath } from './tools.ts'

export const MANAGED = '<!-- managed by claude-mods -->'
const MANAGED_FILE = '.claude-mods-managed'

// ~/.agents/skills is read by Codex, Gemini CLI and Copilot CLI; Cursor reads ~/.cursor/skills.
export const skillRoots = (home: string, tools: readonly ToolName[]): string[] => [
  ...(tools.some(tool => tool !== 'cursor') ? [join(home, '.agents', 'skills')] : []),
  ...(tools.includes('cursor') ? [join(home, '.cursor', 'skills')] : []),
]

const shipSkill = (runtimeMain: string): string => `---
name: ship
description: Run the project checks and, only if they pass, commit the current task's changes, push the branch and open a draft PR. Use when the user says ship, /ship, or asks to commit and open a PR.
---
${MANAGED}
1. From the project root run: \`node "${runtimeMain}" check\`
2. If it prints "checks fail", stop. Show the failures and do not commit.
3. Otherwise commit only the changes that belong to the current task, with a concise message in the repo's style.
4. Push the branch and open a draft PR (use \`gh pr create --draft\` if available) that says what changed and why.
5. Make no other changes. If any step fails, stop and report it.
`

const checksSkill = (runtimeMain: string): string => `---
name: checks
description: Run the project's spec checks (or typecheck + lint) and report the result. Use when the user says checks or /checks.
---
${MANAGED}
Run \`node "${runtimeMain}" check\` from the project root and report its output. Fix nothing unless asked.
`

const geminiCommand = (description: string, skill: string): string =>
  `# ${MANAGED}\ndescription = ${JSON.stringify(description)}\nprompt = ${JSON.stringify(`Follow these steps exactly.\n\n${skill.split(MANAGED)[1]?.trim() ?? ''}\n\n{{args}}`)}\n`

const isManagedFile = (path: string): boolean => !existsSync(path) || readFileSync(path, 'utf8').includes(MANAGED)

// A skill folder holding only our SKILL.md goes with it; anything the user added there stays.
const planManagedFile = (plan: Plan, path: string, content: string | undefined): void => {
  if (!isManagedFile(path)) {
    plan.note(`${path} exists and is not managed by claude-mods, so it was left alone.`)
    return
  }
  if (content !== undefined) return plan.write(path, content, true)
  const dir = dirname(path)
  const isOnlyOurs = path.endsWith('SKILL.md') && existsSync(dir) && readdirSync(dir).every(name => name === 'SKILL.md')
  plan.remove(isOnlyOurs ? dir : path, true)
}

export const planCommands = (plan: Plan, home: string, tools: readonly ToolName[], runtimeMain: string | undefined): void => {
  const ship = runtimeMain === undefined ? undefined : shipSkill(runtimeMain)
  const checks = runtimeMain === undefined ? undefined : checksSkill(runtimeMain)
  for (const root of skillRoots(home, tools)) {
    planManagedFile(plan, join(root, 'ship', 'SKILL.md'), ship)
    planManagedFile(plan, join(root, 'checks', 'SKILL.md'), checks)
  }
  if (tools.includes('gemini')) {
    const commands = join(home, '.gemini', 'commands')
    planManagedFile(plan, join(commands, 'ship.toml'), ship && geminiCommand('Run checks, then commit, push and open a draft PR.', ship))
    planManagedFile(plan, join(commands, 'checks.toml'), checks && geminiCommand('Run the project checks.', checks))
  }
}

// Default skills come from the user's own Claude Code installs: plugin cache, ~/.claude/skills, or skills synced
// from their claude.ai account (~/.claude/skills/synced/<id>/), and are copied per tool.
export const findClaudeSkill = (home: string, ref: SkillRef): string | undefined => {
  if (ref.plugin === undefined) {
    const skills = join(home, '.claude', 'skills')
    const synced = join(skills, 'synced')
    const bases = [skills, ...(existsSync(synced) ? readdirSync(synced).map(id => join(synced, id)) : [])]
    return bases.map(base => join(base, ref.skill)).find(dir => existsSync(join(dir, 'SKILL.md')))
  }
  const cache = join(home, '.claude', 'plugins', 'cache')
  if (!existsSync(cache)) return undefined
  for (const marketplace of readdirSync(cache)) {
    const pluginDir = join(cache, marketplace, ref.plugin)
    if (!existsSync(pluginDir)) continue
    const version = newestVersion(readdirSync(pluginDir).filter(name => statSync(join(pluginDir, name)).isDirectory()))
    const dir = version === undefined ? undefined : join(pluginDir, version, 'skills', ref.skill)
    if (dir !== undefined && existsSync(join(dir, 'SKILL.md'))) return dir
  }
  return undefined
}

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })

export const planDefaultSkills = (
  plan: Plan,
  home: string,
  tools: readonly ToolName[],
  skillList: string,
  isRemoving: boolean,
): SkillRef[] => {
  const refs = parseSkillList(skillList)
  const found: SkillRef[] = []
  for (const ref of refs) {
    const source = isRemoving ? undefined : findClaudeSkill(home, ref)
    if (!isRemoving && source === undefined) {
      plan.note(`default skill ${ref.plugin ? `${ref.plugin}:` : ''}${ref.skill} not found in your Claude Code installs; skipped.`)
      continue
    }
    found.push(ref)
    for (const root of skillRoots(home, tools)) {
      const target = join(root, ref.skill)
      const marker = join(target, MANAGED_FILE)
      if (existsSync(target) && !existsSync(marker)) {
        plan.note(`${target} exists and is not managed by claude-mods, so it was left alone.`)
        continue
      }
      if (source === undefined) {
        plan.remove(target, true)
        continue
      }
      // Copied as written; a plugin's own scripts keep running from its Claude Code install.
      const pluginRoot = ref.plugin === undefined ? source : dirname(dirname(source))
      for (const file of listFiles(source)) {
        const bytes = readFileSync(file)
        const rel = relative(source, file)
        if (bytes.includes(0)) {
          plan.note(`${rel} in ${ref.skill} looks binary; not copied.`)
          continue
        }
        const text = bytes.toString('utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot).replaceAll('${CLAUDE_SKILL_DIR}', target)
        plan.write(join(target, rel), text, true)
      }
      plan.write(marker, 'Copied by claude-mods from your Claude Code install. `npx claude-mods update` refreshes it.\n', true)
    }
  }
  return found
}

export const planInstructions = (
  plan: Plan,
  home: string,
  tools: readonly ToolName[],
  lines: readonly string[] | undefined,
): void => {
  for (const tool of tools) {
    const path = instructionsPath(home, tool)
    if (path === undefined) {
      if (lines !== undefined && lines.length > 0) plan.note('cursor: add the guardrails and default-skill lines to Cursor Settings → Rules yourself (Cursor keeps user rules in its UI, not a file).')
      continue
    }
    const current = readText(path) ?? ''
    const next = withBlock(current, lines === undefined || lines.length === 0 ? undefined : lines.join('\n'))
    if (next === '' && current === '') continue
    plan.write(path, next)
  }
}
