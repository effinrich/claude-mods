import type { EngineInterface, PluginOptions, Register, SessionUsage } from 'claude-code'

type Thresholds = { warnPercent: number; forkPercent: number }

export type Reading = {
  percent: number | undefined
  costUsd: number | undefined
  compactions: number
  model: string
  rateLimit: { kind: string; percentUsed: number } | undefined
}

const RATE_LIMIT_SHOWN_FROM = 50

const percentOption = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value > 0 && value <= 100 ? value : fallback

const readThresholds = (options: PluginOptions): Thresholds => {
  const warnPercent = percentOption(options.warnPercent, 60)
  return { warnPercent, forkPercent: Math.max(warnPercent, percentOption(options.forkPercent, 80)) }
}

const shortModel = (model: string): string => model.replace(/^claude-/, '').replace(/\[.*\]$/, '')

export const renderReading = (reading: Reading, thresholds: Thresholds): string => {
  const parts: string[] = []
  if (reading.percent === undefined) parts.push('ctx –')
  else if (reading.percent >= thresholds.forkPercent) parts.push(`ctx ${reading.percent}% ⛔ fork soon`)
  else if (reading.percent >= thresholds.warnPercent) parts.push(`ctx ${reading.percent}% ⚠`)
  else parts.push(`ctx ${reading.percent}%`)

  if (reading.costUsd !== undefined) parts.push(`$${reading.costUsd.toFixed(2)}`)
  if (reading.compactions > 0) parts.push(`${reading.compactions}× compacted`)
  if (reading.rateLimit !== undefined) parts.push(`${reading.rateLimit.kind} ${reading.rateLimit.percentUsed}%`)
  parts.push(shortModel(reading.model))
  return parts.join(' · ')
}

const busiestLimit = (usage: SessionUsage): Reading['rateLimit'] => {
  const top = [...usage.rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
  return top !== undefined && top.percentUsed >= RATE_LIMIT_SHOWN_FROM
    ? { kind: top.kind, percentUsed: Math.round(top.percentUsed) }
    : undefined
}

// One entry for the current session only, so the store never grows.
const readCompactions = async ($: EngineInterface): Promise<number> => {
  const [stored, sessionId] = await Promise.all([$.store.get('compactions'), $.session.id()])
  if (typeof stored !== 'object' || stored === null) return 0
  const { session, count } = stored as Record<string, unknown>
  return session === sessionId && typeof count === 'number' ? count : 0
}

const refresh = async ($: EngineInterface, thresholds: Thresholds): Promise<void> => {
  const [usage, model, compactions] = await Promise.all([$.session.usage(), $.session.model(), readCompactions($)])
  $.ui.status(
    renderReading(
      {
        percent: usage.context.percent,
        costUsd: usage.cost?.usd,
        compactions,
        model,
        rateLimit: busiestLimit(usage),
      },
      thresholds,
    ),
  )
}

export const register: Register = (on, options) => {
  const thresholds = readThresholds(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refresh($, thresholds)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await refresh($, thresholds)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.skip !== undefined) return result
    const [count, session] = await Promise.all([readCompactions($), $.session.id()])
    await $.store.set('compactions', { session, count: count + 1 })
    await refresh($, thresholds)
    return result
  }).catch(($, e, next) => next(e))
}
