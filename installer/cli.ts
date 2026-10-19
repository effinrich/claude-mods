import type { Plan } from './files.ts'

export type ModName = 'guardrails' | 'compaction-guard' | 'context-audit' | 'default-skills'
export type Log = (line: string) => void

export const ALL_MODS: readonly ModName[] = ['guardrails', 'compaction-guard', 'context-audit', 'default-skills']
export const CLAUDE_EXTRAS = ['context-meter', 'cli-passthrough'] as const
export const DEFAULT_SKILLS = 'ponytail:ponytail full, feature-based-architecture, default-skills:plain-writing'
export const MARKETPLACE = 'effinrich/claude-mods'

export const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  if (index !== -1) return args[index + 1]
  return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

export const parseList = <T extends string>(value: string | undefined, allowed: readonly T[]): T[] | undefined => {
  if (value === undefined) return undefined
  if (value === 'all') return [...allowed]
  const items = value.split(',').map(item => item.trim()).filter(item => item !== '')
  const unknown = items.filter(item => !allowed.includes(item as T))
  if (unknown.length > 0) throw new Error(`unknown: ${unknown.join(', ')} (choose from ${allowed.join(', ')})`)
  return items as T[]
}

export const describePlan = (plan: Plan, log: Log, show: (path: string) => string = path => path): void => {
  for (const change of plan.changes) log(`  ${change.action === 'remove' ? 'remove' : 'write '} ${show(change.path)}`)
  for (const note of plan.notes) log(`  note: ${note}`)
}

export const backupStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')
