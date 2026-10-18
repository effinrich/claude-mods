import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { diffSnapshots, sha256, snapshotFile, type FileSnapshot, type Snapshot } from './drift.ts'
import { enabledPlugins, formatTokens, measureOverhead, renderOverhead, type Overhead } from './overhead.ts'

const DEFAULT_WARN_TOKENS = 30_000
// MCP servers connect after the session starts; measuring later counts their tools.
const AUDIT_DELAY_MS = 5_000
const GLOBAL_MEMORY_TYPES: ReadonlySet<string> = new Set(['User', 'Managed'])
const SNAPSHOT_KEY = 'snapshot'
const BASELINE_KEY = 'baseline'
const GROWTH_FACTOR = 1.1

const readWarnTokens = (options: PluginOptions): number =>
  typeof options.warnTokens === 'number' && options.warnTokens > 0 ? options.warnTokens : DEFAULT_WARN_TOKENS

const isSnapshot = (value: unknown): value is Snapshot =>
  typeof value === 'object' &&
  value !== null &&
  'files' in value &&
  'plugins' in value &&
  'hooksSha' in value &&
  Array.isArray(value.plugins)

const measure = async ($: EngineInterface): Promise<Overhead | undefined> => {
  const [usage, settings] = await Promise.all([$.session.usage({ breakdown: 'summary' }), $.settings.read()])
  const breakdown = usage.context.breakdown
  return breakdown === undefined ? undefined : measureOverhead(breakdown, settings)
}

const takeSnapshot = async ($: EngineInterface): Promise<Snapshot> => {
  const [usage, merged, user] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }),
    $.settings.read(),
    $.settings.read({ source: 'user' }),
  ])
  const globalFiles = (usage.context.breakdown?.memoryFiles ?? []).filter(file => GLOBAL_MEMORY_TYPES.has(file.type))
  const files: Record<string, FileSnapshot> = {}
  for (const file of globalFiles) {
    const text = await $.fs.read(file.path).catch(() => undefined)
    if (typeof text === 'string') files[file.path] = await snapshotFile(text)
  }
  return {
    files,
    plugins: enabledPlugins(merged),
    hooksSha: await sha256(JSON.stringify(user.hooks ?? null)),
  }
}

const showStatus = ($: EngineInterface, overhead: Overhead, warnTokens: number): void => {
  const isOver = overhead.baselineTokens > warnTokens
  $.ui.status(`ctx base ${formatTokens(overhead.baselineTokens)}${isOver ? ' ⚠' : ''}`)
}

// Toasts only when over the limit and first measured or grown, so a known-heavy setup stays quiet.
const warnIfGrown = async ($: EngineInterface, overhead: Overhead, warnTokens: number): Promise<void> => {
  const previous = await $.store.get(BASELINE_KEY)
  await $.store.set(BASELINE_KEY, overhead.baselineTokens)
  const hasGrown = typeof previous !== 'number' || overhead.baselineTokens > previous * GROWTH_FACTOR
  if (overhead.baselineTokens <= warnTokens || !hasGrown) return

  const growth =
    typeof previous === 'number' ? ` (up from ${formatTokens(previous)})` : ''
  const biggest = overhead.contributors
    .slice(0, 2)
    .map(item => `${item.label} ${formatTokens(item.tokens)}`)
    .join(', ')
  $.ui.toast(
    `Fixed context is ${formatTokens(overhead.baselineTokens)} tokens per turn${growth}. Biggest: ${biggest}. Details in the transcript.`,
    { timeoutMs: 12_000 },
  )
  $.ui.log(renderOverhead(overhead, warnTokens))
}

const indent = (entry: string): string => entry.replace(/^/gm, '  ')

const firstLine = (entry: string | undefined): string => entry?.split('\n')[0] ?? ''

const checkDrift = async ($: EngineInterface): Promise<void> => {
  const current = await takeSnapshot($)
  const stored = await $.store.get(SNAPSHOT_KEY)
  await $.store.set(SNAPSHOT_KEY, current)
  if (!isSnapshot(stored)) return

  const changes = diffSnapshots(stored, current)
  if (changes.length === 0) return
  $.ui.log(`context-audit: changed since your last session\n${changes.map(indent).join('\n')}`)
  $.ui.toast(`Global context changed: ${firstLine(changes[0])}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ''}`, {
    timeoutMs: 15_000,
  })
  $.ui.notify(changes.join('\n'), { title: 'Claude Code context changed' }).catch(() => undefined)
}

const audit = async ($: EngineInterface, warnTokens: number): Promise<void> => {
  const overhead = await measure($)
  if (overhead !== undefined) {
    showStatus($, overhead, warnTokens)
    await warnIfGrown($, overhead, warnTokens)
  }
  await checkDrift($)
}

export const register: Register = (on, options) => {
  const warnTokens = readWarnTokens(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'context-audit',
      description: 'Show the fixed context every turn carries and what contributes most.',
      immediate: true,
    })
    $.clock.after(AUDIT_DELAY_MS, () => {
      audit($, warnTokens).catch(error => $.ui.log(`context-audit failed: ${String(error)}`, { to: 'debug' }))
    })
    return result
  })

  on('command.run', { command: 'context-audit' }, async $ => {
    const overhead = await measure($)
    if (overhead === undefined) return { text: 'context-audit: the context breakdown is not available yet.' }
    $.ui.log(renderOverhead(overhead, warnTokens))
    showStatus($, overhead, warnTokens)
    return {}
  })
}
