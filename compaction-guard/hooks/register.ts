import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code'
import { buildHandoff, renderHandoff } from './handoff.ts'

type Config = {
  handoffPath: string | undefined
  thrashCount: number
  thrashWindowMs: number
}

const FRESH_HANDOFF_MS = 6 * 60 * 60_000
const TRACKED_SESSIONS = 50

const SUMMARY_INSTRUCTIONS =
  'Keep the current plan, the open todos and the decisions made. A handoff with the original task, ' +
  'recent asks and touched files is attached after this summary, so do not repeat those.'

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const readConfig = (options: PluginOptions): Config => ({
  handoffPath:
    typeof options.handoffPath === 'string' && options.handoffPath.trim() !== '' ? options.handoffPath.trim() : undefined,
  thrashCount: Math.max(2, Math.round(positive(options.thrashCount, 3))),
  thrashWindowMs: positive(options.thrashWindowMinutes, 10) * 60_000,
})

const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

const joinPath = (root: string, path: string): string =>
  isAbsolute(path) ? path : `${root.replace(/[\\/]+$/, '')}/${path}`

const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'project'

const shortHash = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest).slice(0, 3)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

const homeDir = async ($: EngineInterface): Promise<string | undefined> =>
  (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

// Default: one file per project under ~/.claude/handoffs, so nothing lands in the repo.
const resolveHandoffPath = async ($: EngineInterface, config: Config, root: string): Promise<string> => {
  if (config.handoffPath !== undefined) return joinPath(root, config.handoffPath)
  const home = await homeDir($)
  const fileName = `${baseName(root)}-${await shortHash(root)}.md`
  return home === undefined ? joinPath(root, `.claude/${fileName}`) : joinPath(home, `.claude/handoffs/${fileName}`)
}

const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number') : []

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : []

// Keeps the store bounded: per-session keys of sessions older than the last TRACKED_SESSIONS go.
const trackSession = async ($: EngineInterface, sessionId: string): Promise<void> => {
  const seen = strings(await $.store.get('sessions'))
  if (seen.includes(sessionId)) return
  const kept = [...seen, sessionId]
  const dropped = kept.splice(0, Math.max(0, kept.length - TRACKED_SESSIONS))
  await Promise.all(dropped.flatMap(id => [$.store.delete(`task:${id}`), $.store.delete(`compactions:${id}`)]))
  await $.store.set('sessions', kept)
}

const writeHandoff = async (
  $: EngineInterface,
  config: Config,
  messages: readonly SessionMessage[],
): Promise<{ text: string; path: string; sessionId: string; now: number }> => {
  const [root, sessionId, now] = await Promise.all([$.session.root(), $.session.id(), $.clock.now()])
  await trackSession($, sessionId)

  const taskKey = `task:${sessionId}`
  const stored = await $.store.get(taskKey)
  const knownTask = typeof stored === 'string' ? stored : undefined
  const handoff = buildHandoff(messages, knownTask)
  if (knownTask === undefined && handoff.originalTask !== undefined) {
    await $.store.set(taskKey, handoff.originalTask)
  }

  const text = renderHandoff(handoff, new Date(now), baseName(root))
  const path = await resolveHandoffPath($, config, root)
  await $.fs.write(path, text)
  return { text, path, sessionId, now }
}

const recordCompaction = async (
  $: EngineInterface,
  config: Config,
  sessionId: string,
  now: number,
): Promise<number[]> => {
  const key = `compactions:${sessionId}`
  const recent = [...numbers(await $.store.get(key)).filter(t => now - t < config.thrashWindowMs), now]
  await $.store.set(key, recent)
  return recent
}

const warnThrash = ($: EngineInterface, recent: readonly number[], now: number): void => {
  const minutes = Math.max(1, Math.round((now - (recent[0] ?? now)) / 60_000))
  const message = `${recent.length} compactions in ${minutes} min. Fork now: /clear, then /handoff-load`
  $.ui.status('⚠ compaction thrash · /clear then /handoff-load')
  $.ui.toast(message, { timeoutMs: 15_000 })
  $.ui.log(`compaction-guard: ${message}. The fixed context is likely too large (see /context-audit).`)
  $.ui.notify(message, { title: 'Compaction thrash' }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const saved = await writeHandoff($, config, e.messages)
    const instructions = e.instructions ? `${e.instructions}\n\n${SUMMARY_INSTRUCTIONS}` : SUMMARY_INSTRUCTIONS
    const result = await next({ ...e, instructions })
    if (result.skip !== undefined) return result

    const recent = await recordCompaction($, config, saved.sessionId, saved.now)
    if (recent.length >= config.thrashCount) warnThrash($, recent, saved.now)
    else $.ui.status(`handoff saved ${clockTime(saved.now)}`)

    const reattached: SessionMessage = {
      role: 'user',
      text: `<handoff source="compaction-guard" path="${saved.path}">\n${saved.text}</handoff>`,
      toolUses: [],
    }
    return { ...result, messages: [...result.messages, reattached] }
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'handoff',
      description: 'Save the task, plan, recent asks and touched files to this project’s handoff now.',
    })
    await $.command.register({
      name: 'handoff-load',
      description: 'Load this project’s last handoff into the conversation.',
    })
    if (!e.isInteractive) return result

    const path = await resolveHandoffPath($, config, await $.session.root())
    const stat = await $.fs.stat(path).catch(() => undefined)
    const now = await $.clock.now()
    if (stat !== undefined && now - stat.mtimeMs < FRESH_HANDOFF_MS) {
      $.ui.toast(`Handoff from ${clockTime(stat.mtimeMs)} is saved. Load it with /handoff-load`, { timeoutMs: 10_000 })
    }
    return result
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const messages = await $.session.messages()
    if (!Array.isArray(messages)) return { text: 'compaction-guard: could not read this session.' }
    const saved = await writeHandoff($, config, messages)
    return { text: `Handoff written to ${saved.path}.` }
  })

  on('command.run', { command: 'handoff-load' }, async $ => {
    const path = await resolveHandoffPath($, config, await $.session.root())
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') return { text: `No handoff saved for this project yet (${path}).` }
    return { text: `Loaded the handoff from ${path}.`, context: [text] }
  })
}
