import type { SessionContextBreakdown, Settings } from 'claude-code'

export type Contributor = { label: string; tokens: number }

export type Overhead = {
  baselineTokens: number
  contributors: readonly Contributor[]
  enabledPlugins: readonly string[]
  injectingHooks: readonly string[]
}

// Settings hook events whose output is added to what the model reads.
const INJECTING_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'PostToolUse', 'SubagentStart']

const TOP_CONTRIBUTORS = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const formatTokens = (tokens: number): string =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens)

export const enabledPlugins = (settings: Settings): string[] => {
  const enabled = settings.enabledPlugins
  if (!isRecord(enabled)) return []
  return Object.entries(enabled)
    .filter(([, isOn]) => isOn === true)
    .map(([id]) => id)
    .sort()
}

export const hookCommandCount = (settings: Settings, event: string): number => {
  const hooks = settings.hooks
  if (!isRecord(hooks)) return 0
  const groups = hooks[event]
  if (!Array.isArray(groups)) return 0
  return groups.reduce<number>(
    (sum, group) => sum + (isRecord(group) && Array.isArray(group.hooks) ? group.hooks.length : 0),
    0,
  )
}

const sumBy = <T>(items: readonly T[], key: (item: T) => string, tokens: (item: T) => number): Map<string, number> => {
  const totals = new Map<string, number>()
  for (const item of items) totals.set(key(item), (totals.get(key(item)) ?? 0) + tokens(item))
  return totals
}

export const measureOverhead = (breakdown: SessionContextBreakdown, settings: Settings): Overhead => {
  // Branching on the row name is a fallback: no category kind separates the conversation from fixed context.
  const baselineTokens = breakdown.categories
    .filter(row => row.kind === 'used' && !/^messages$/i.test(row.name.trim()))
    .reduce((sum, row) => sum + row.tokens, 0)

  const memory = breakdown.memoryFiles.map(file => ({
    label: `${file.type} memory ${file.path}`,
    tokens: file.tokens,
  }))
  const mcp = [...sumBy(breakdown.mcpTools.filter(tool => tool.isLoaded), t => t.serverName, t => t.tokens)].map(
    ([server, tokens]) => ({ label: `MCP ${server}`, tokens }),
  )
  const skills = [
    ...sumBy(breakdown.skills?.skillFrontmatter ?? [], s => s.pluginName ?? s.source, s => s.tokens),
  ].map(([owner, tokens]) => ({ label: `skills from ${owner}`, tokens }))
  const agents = breakdown.agents.reduce((sum, agent) => sum + agent.tokens, 0)
  const listings: Contributor[] = [
    { label: `${breakdown.agents.length} agent descriptions`, tokens: agents },
    { label: 'slash command listing', tokens: breakdown.slashCommands?.tokens ?? 0 },
  ]

  const itemized = [...memory, ...mcp, ...skills, ...listings].filter(item => item.tokens > 0)
  const itemizedTokens = itemized.reduce((sum, item) => sum + item.tokens, 0)
  const contributors = [...itemized.sort((a, b) => b.tokens - a.tokens).slice(0, TOP_CONTRIBUTORS)]
  if (baselineTokens > itemizedTokens) {
    contributors.push({ label: 'system prompt and built-in tools', tokens: baselineTokens - itemizedTokens })
  }

  const injectingHooks = INJECTING_EVENTS.map(event => [event, hookCommandCount(settings, event)] as const)
    .filter(([, count]) => count > 0)
    .map(([event, count]) => `${event} ×${count}`)

  return { baselineTokens, contributors, enabledPlugins: enabledPlugins(settings), injectingHooks }
}

export const renderOverhead = (overhead: Overhead, warnTokens: number): string => {
  const isOver = overhead.baselineTokens > warnTokens
  const lines = [
    `context-audit: fixed context ${formatTokens(overhead.baselineTokens)} tokens per turn` +
      (isOver ? ` (over your ${formatTokens(warnTokens)} limit)` : ''),
    ...overhead.contributors.map(item => `  ${formatTokens(item.tokens).padStart(6)}  ${item.label}`),
    `  ${overhead.enabledPlugins.length} plugins enabled`,
  ]
  if (overhead.injectingHooks.length > 0) {
    lines.push(`  settings hooks that add context: ${overhead.injectingHooks.join(', ')}`)
  }
  return lines.join('\n')
}
