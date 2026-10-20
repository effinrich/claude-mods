import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { run } from '../main.ts'

let home = ''
let lines: string[] = []

const put = (path: string, text: string): void => {
  mkdirSync(dirname(join(home, path)), { recursive: true })
  writeFileSync(join(home, path), text)
}
const read = (path: string): string => readFileSync(join(home, path), 'utf8')
const json = (path: string): Record<string, any> => JSON.parse(read(path)) as Record<string, any>
const install = (...args: string[]) => run(['install', '--tools', 'codex,gemini,cursor,copilot', ...args], home, line => lines.push(line))

const USER_CODEX_HOOK = { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/mine.py' }] }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'claude-mods-home-'))
  process.env.CLAUDE_MODS_HOME = join(home, '.claude-mods')
  lines = []
  put('.codex/hooks.json', JSON.stringify({ hooks: { PreToolUse: [USER_CODEX_HOOK] } }))
  put('.codex/AGENTS.md', '# My rules\nUse pnpm.\n')
  put('.gemini/settings.json', JSON.stringify({ model: { name: 'gemini-2.5-pro' }, hooks: { AfterTool: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }))
  put('.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { stop: [{ command: './audit.sh' }] } }))
  mkdirSync(join(home, '.copilot'), { recursive: true })
  put('.claude/plugins/cache/ponytail/ponytail/4.9.0/skills/ponytail/SKILL.md', 'old')
  put('.claude/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md', '---\nname: ponytail\ndescription: style\n---\nRun ${CLAUDE_PLUGIN_ROOT}/bin/x')
})

test('wires every tool, keeps the user own hooks and settings, and is idempotent', () => {
  assert.equal(install(), 0)
  assert.equal(install(), 0)

  const codex = json('.codex/hooks.json').hooks
  assert.deepEqual(Object.keys(codex).sort(), ['PreCompact', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.equal(codex.PreToolUse.length, 2)
  assert.deepEqual(codex.PreToolUse[0], USER_CODEX_HOOK)

  const gemini = json('.gemini/settings.json')
  assert.equal(gemini.model.name, 'gemini-2.5-pro')
  assert.equal(gemini.hooks.AfterTool[0].hooks[0].command, 'mine.sh')
  assert.equal(gemini.hooks.AfterAgent[0].hooks[0].timeout, 900_000)

  const cursor = json('.cursor/hooks.json')
  assert.equal(cursor.version, 1)
  assert.equal(cursor.hooks.stop.length, 2)
  assert.equal(cursor.hooks.stop[1].loop_limit, 3)

  const agentStop = json('.copilot/hooks/claude-mods.json').hooks.agentStop[0]
  assert.equal(agentStop.timeoutSec, 900)
  assert.equal(agentStop.powershell, `& ${agentStop.bash}`)
  assert.match(agentStop.bash, /^"[^"]+" "[^"]+main\.js" copilot agentStop$/)
  assert.match(read('.agents/skills/ship/SKILL.md'), /name: ship/)
  assert.match(read('.cursor/skills/checks/SKILL.md'), /name: checks/)
  assert.match(read('.gemini/commands/ship.toml'), /^description = /m)

  const ponytail = read('.agents/skills/ponytail/SKILL.md')
  assert.match(ponytail, /ponytail[\\/]ponytail[\\/]4\.10\.0[\\/]bin[\\/]x/)
  assert.ok(existsSync(join(home, '.agents/skills/ponytail/.claude-mods-managed')))

  const agents = read('.codex/AGENTS.md')
  assert.match(agents, /^# My rules\nUse pnpm\.\n\n<!-- claude-mods:start/)
  assert.match(agents, /Always on: the `ponytail` skill with arguments `full`/)
  assert.equal(agents.match(/claude-mods:start/g)?.length, 1)
})

test('the installed hook command runs the runtime and blocks a destructive command', () => {
  install()
  const command: string = json('.codex/hooks.json').hooks.PreToolUse[1].hooks[0].command
  const output = execSync(command.replace('PreToolUse', 'PreToolUse'), {
    input: JSON.stringify({ session_id: 's', cwd: home, tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_MODS_HOME: join(home, '.claude-mods') },
  })
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, 'deny')
})

test('uninstall removes only what install added', () => {
  install()
  assert.equal(run(['uninstall'], home, line => lines.push(line)), 0)

  assert.deepEqual(json('.codex/hooks.json').hooks, { PreToolUse: [USER_CODEX_HOOK] })
  assert.deepEqual(Object.keys(json('.gemini/settings.json').hooks), ['AfterTool'])
  assert.equal(json('.cursor/hooks.json').hooks.stop.length, 1)
  assert.equal(existsSync(join(home, '.copilot/hooks/claude-mods.json')), false)
  assert.equal(existsSync(join(home, '.agents/skills/ship')), false)
  assert.equal(existsSync(join(home, '.agents/skills/ponytail')), false)
  assert.equal(read('.codex/AGENTS.md'), '# My rules\nUse pnpm.\n')
})

test('dry run changes nothing and lists what it would write', () => {
  const before = read('.codex/hooks.json')
  assert.equal(install('--dry-run'), 0)
  assert.equal(read('.codex/hooks.json'), before)
  assert.ok(lines.some(line => line.includes(join(home, '.codex', 'hooks.json'))))
  assert.equal(existsSync(join(home, '.claude-mods/runtime')), false)
})

test('leaves a settings file it cannot parse alone and says so', () => {
  put('.gemini/settings.json', '{ // comment\n "model": {} }')
  install()
  assert.equal(read('.gemini/settings.json'), '{ // comment\n "model": {} }')
  assert.ok(lines.some(line => line.includes('not plain JSON')))
})

test('does not overwrite a skill the user wrote', () => {
  put('.agents/skills/ship/SKILL.md', '---\nname: ship\n---\nmy own ship')
  install()
  assert.equal(read('.agents/skills/ship/SKILL.md'), '---\nname: ship\n---\nmy own ship')
  assert.ok(lines.some(line => line.includes('not managed by claude-mods')))
})

test('doctor warns when the Node baked into the hooks is gone and explains payload capture', () => {
  install()
  const path = join(home, '.cursor/hooks.json')
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll(JSON.stringify(process.execPath).slice(1, -1), '/gone/node/v18/bin/node'))
  lines = []
  assert.equal(run(['doctor'], home, line => lines.push(line)), 0)
  assert.ok(lines.some(line => line.includes('/gone/node/v18/bin/node, which no longer exists')))
  assert.ok(lines.some(line => line.includes('claude-mods update')))
  assert.ok(lines.some(line => line.includes('CLAUDE_MODS_DEBUG=1')))
})

test('a reinstall keeps debug turned on in config.json', () => {
  install()
  const path = join(home, '.claude-mods/config.json')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), debug: true }))
  install()
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).debug, true)
})

test('copies the bundled plain-writing skill to every tool without a Claude Code install', () => {
  install()
  const skill = read('.agents/skills/plain-writing/SKILL.md')
  assert.match(skill, /^---\nname: plain-writing\ndescription: .+\n---\n/)
  assert.ok(skill.split(/\s+/).length < 450, 'pinned every turn, so it must stay short')
  assert.ok(existsSync(join(home, '.cursor/skills/plain-writing/SKILL.md')))
  assert.match(read('.codex/AGENTS.md'), /the `plain-writing` skill/)
})

test('doctor shows block counts per rule and the tokens pinned into every turn', () => {
  install()
  put('.claude-mods/blocks.log', [
    JSON.stringify({ at: new Date().toISOString(), tool: 'codex', rule: 'writing', reason: 'x' }),
    JSON.stringify({ at: new Date().toISOString(), tool: 'codex', rule: 'writing', reason: 'y' }),
    JSON.stringify({ at: '2020-01-01T00:00:00.000Z', tool: 'codex', rule: 'scope', reason: 'old' }),
  ].join('\n'))
  put('.claude/plugins/cache/ponytail/ponytail/4.10.0/skills/ponytail/SKILL.md', `---\nname: ponytail\n---\n${'word '.repeat(2000)}`)
  lines = []
  run(['doctor'], home, line => lines.push(line))
  assert.ok(lines.some(line => line.includes('blocks in the last 7 days: writing 2')), lines.join('\n'))
  assert.ok(lines.some(line => /pinned per turn: ~\d+ tokens \(ponytail:ponytail full ~2500, feature-based-architecture not found, default-skills:plain-writing ~\d+, guardrails rule ~110\)/.test(line)), lines.join('\n'))
  assert.ok(lines.some(line => line.includes('WARNING: over ~2000 tokens')))
})

test('update follows the skills in the user profile over the ones stored at install', () => {
  install()
  assert.match(read('.codex/AGENTS.md'), /the `ponytail` skill/)
  put('.claude-mods/profile.json', JSON.stringify({ skills: ['default-skills:plain-writing'] }))
  assert.equal(run(['update'], home, line => lines.push(line)), 0)
  assert.doesNotMatch(read('.codex/AGENTS.md'), /the `ponytail` skill/)
  assert.match(read('.codex/AGENTS.md'), /the `plain-writing` skill/)
})
