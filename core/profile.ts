// One file that sets skills and gate settings for every surface: Claude Code plugins, the other tools' hooks, the
// installer, `project` and crew agents. A repo's `.claude/claude-mods.json` (committed, the team's) overrides the
// user's `~/.claude-mods/profile.json` key by key.

export type GuardrailsSettings = {
  stopGate?: boolean
  writingGate?: boolean
  researchHoldLines?: number
  checkTimeoutMinutes?: number
  backgroundChecks?: 'auto' | 'on' | 'off'
}

export type Profile = {
  skills?: string
  roles?: Readonly<Record<string, string>>
  guardrails?: GuardrailsSettings
  crewCap?: number
  tokenBudget?: number
}

export const PROFILE_FILE = '.claude/claude-mods.json'
export const USER_PROFILE_FILE = 'profile.json'
export const DEFAULT_TOKEN_BUDGET = 2000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const skillText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : undefined

const positive = (value: unknown): number | undefined => (typeof value === 'number' && value >= 0 ? value : undefined)

const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const backgroundMode = (value: unknown): 'auto' | 'on' | 'off' | undefined =>
  value === 'auto' || value === 'on' || value === 'off' ? value : undefined

const withoutUndefined = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

// Unknown keys and wrong types are dropped rather than trusted, so a typo can't switch a gate off by accident.
export const parseProfile = (text: string | undefined): Profile => {
  if (text === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const roles = isRecord(parsed.roles)
    ? Object.fromEntries(Object.entries(parsed.roles).flatMap(([role, skills]) => (skillText(skills) === undefined ? [] : [[role, skillText(skills) ?? '']])))
    : undefined
  const guardrails = isRecord(parsed.guardrails)
    ? withoutUndefined({
        stopGate: flag(parsed.guardrails.stopGate),
        writingGate: flag(parsed.guardrails.writingGate),
        researchHoldLines: positive(parsed.guardrails.researchHoldLines),
        checkTimeoutMinutes: positive(parsed.guardrails.checkTimeoutMinutes),
        backgroundChecks: backgroundMode(parsed.guardrails.backgroundChecks),
      })
    : undefined
  const crew = isRecord(parsed.crew) ? parsed.crew : {}
  return withoutUndefined({
    skills: skillText(parsed.skills),
    roles,
    guardrails,
    crewCap: positive(crew.cap),
    tokenBudget: positive(parsed.tokenBudget),
  })
}

export const mergeProfiles = (user: Profile, repo: Profile): Profile => ({
  ...user,
  ...repo,
  roles: { ...user.roles, ...repo.roles },
  guardrails: { ...user.guardrails, ...repo.guardrails },
})
