type Rule = { pattern: RegExp; reason: string; isTypeScriptOnly?: true }

const COMMAND_RULES: readonly Rule[] = [
  { pattern: /--no-verify\b/, reason: 'skips the hooks that guard commits; fix what they report instead' },
  { pattern: /\bgit\s+commit\b[^|;&]*\s-[a-zA-Z]*n[a-zA-Z]*\b/, reason: '`-n` skips the commit hooks; fix what they report instead' },
  {
    pattern: /\bgit\s+push\b[^|;&]*(\s--force(?!-with-lease)\b|\s-[a-zA-Z]*f\b)/,
    reason: 'force-pushing rewrites shared history; use --force-with-lease on your own branch only if the user asks',
  },
  { pattern: /\bgit\s+reset\s+[^|;&]*--hard\b/, reason: 'destroys uncommitted work' },
  { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, reason: 'discards every uncommitted change' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: 'deletes untracked files for good' },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME)(\/?\s|\/?$)/, reason: 'deletes a home or root directory' },
  {
    pattern: /\b(vitest|jest|playwright)\b[^|;&]*\s(-u|--update|--updateSnapshot|--update-snapshots)\b/,
    reason: 'rewrites snapshots to match the current output; fix the code, or ask the user to approve new snapshots',
  },
  {
    pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b[^|;&]*\s(-u|--update|--updateSnapshot|--update-snapshots)\b/,
    reason: 'rewrites snapshots to match the current output; fix the code, or ask the user to approve new snapshots',
  },
]

export const judgeCommand = (command: string): string | undefined =>
  COMMAND_RULES.find(rule => rule.pattern.test(command))?.reason

export const isGitCommit = (command: string): boolean => /\bgit\s+commit\b/.test(command)

const WEAKENING: readonly Rule[] = [
  { pattern: /\b(it|test|describe)\.(skip|only)\s*\(/, reason: 'skips or isolates tests' },
  { pattern: /\b(xit|xdescribe|xtest)\s*\(/, reason: 'skips tests' },
  { pattern: /@ts-(ignore|nocheck|expect-error)\b/, reason: 'silences the type checker' },
  { pattern: /eslint-disable/, reason: 'silences the linter' },
  { pattern: /\bas\s+any\b|:\s*any\b(?!\w)|<any>/, reason: 'adds an `any` type', isTypeScriptOnly: true },
  {
    pattern: /\b(vi|jest)\.(mock|doMock)\(\s*['"`]\.\.?\//,
    reason: 'mocks one of your own modules; mock only system boundaries (network, time, filesystem) and test the real code',
  },
]

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|tests?)\/.+\.[cm]?[jt]sx?$)/
const ASSERTION = /\bexpect\s*\(|\bassert(\.\w+)?\s*\(|\.should\b/g

const countAssertions = (code: string): number => code.match(ASSERTION)?.length ?? 0

const COVERAGE_CONFIG = /(^|\/)((vitest|vite|jest)\.config\.[cm]?[jt]s|jest\.config\.json|package\.json|\.nycrc(\.json)?)$/
const THRESHOLD = /\b(lines|branches|functions|statements)['"]?\s*:\s*(\d+(\.\d+)?)/g

const thresholds = (code: string): Map<string, number> => {
  const found = new Map<string, number>()
  for (const match of code.matchAll(THRESHOLD)) {
    const key = match[1] ?? ''
    const value = Number(match[2])
    found.set(key, Math.min(found.get(key) ?? value, value))
  }
  return found
}

// Test-runner config is not source, but lowering its coverage thresholds weakens the checks all the same.
export const isCoverageConfig = (path: string): boolean => COVERAGE_CONFIG.test(path)

const loweredThreshold = (newCode: string, oldCode: string): string | undefined => {
  const after = thresholds(newCode)
  for (const [key, before] of thresholds(oldCode)) {
    const now = after.get(key)
    if (now !== undefined && now < before) return `lowers the ${key} coverage threshold from ${before} to ${now}`
  }
  return undefined
}

const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/

export const isLockfile = (path: string): boolean => LOCKFILES.test(path)

// Only what the edit adds counts, so touching a file that already has a suppression is fine.
export const judgeWeakening = (newCode: string, oldCode: string, path: string): string | undefined => {
  if (COVERAGE_CONFIG.test(path)) {
    const lowered = loweredThreshold(newCode, oldCode)
    if (lowered !== undefined) return lowered
  }
  if (TEST_FILE.test(path) && countAssertions(newCode) < countAssertions(oldCode)) {
    return `removes assertions from a test (${countAssertions(oldCode)} → ${countAssertions(newCode)})`
  }
  const isTypeScript = /\.(c|m)?tsx?$/.test(path)
  for (const rule of WEAKENING) {
    if (rule.isTypeScriptOnly === true && !isTypeScript) continue
    const count = (code: string): number => code.split('\n').filter(line => rule.pattern.test(line)).length
    if (count(newCode) > count(oldCode)) return rule.reason
  }
  return undefined
}

// Commands whose text lands in front of people: commit messages, tags, PR and issue text.
const PROSE_COMMAND = /\bgit\s+(commit|tag)\b|\bgh\s+(pr|issue)\s+(create|edit|comment|review)\b/

// Few and unambiguous on purpose: each one blocks a commit until the message is reworded.
const SLOP: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /—/, label: 'an em dash' },
  { pattern: /\bdelv(e|es|ed|ing)\b/i, label: '"delve"' },
  { pattern: /\bseamless(ly)?\b/i, label: '"seamless"' },
  { pattern: /\bleverag(e|es|ed|ing)\b/i, label: '"leverage"' },
  { pattern: /\brobust(ly|ness)?\b/i, label: '"robust"' },
  { pattern: /\bcomprehensive\b/i, label: '"comprehensive"' },
  { pattern: /\bit['’]?s worth noting\b/i, label: '"it\'s worth noting"' },
  { pattern: /\b(a testament to|rich tapestry|game[- ]changer|in today['’]s fast-paced)\b/i, label: 'stock AI phrasing' },
  { pattern: /\bI hope this helps\b/i, label: '"I hope this helps"' },
]

export const judgeProse = (command: string): string | undefined => {
  if (!PROSE_COMMAND.test(command)) return undefined
  const hits = SLOP.filter(rule => rule.pattern.test(command)).map(rule => rule.label)
  return hits.length === 0 ? undefined : `the message uses ${hits.join(', ')}`
}

const CLAIM = /\b((all\s+)?(tests?|checks?|specs?|the\s+suite)\s+(now\s+)?(pass(es|ed|ing)?|are\s+(passing|green)|succeed(ed|s)?)|all\s+green|build\s+(passes|succeeds)|everything\s+(passes|works)|verified|fixed)\b/i
const NEGATED = /(\bnot|n['\u2019]t|\bnever|\bno|\bunable\s+to|\bcould\s+not|\bwithout)\s+(\w+\s+){0,2}$/i

// The first success claim in a reply that isn't negated just before it ("not verified", "couldn't get tests to pass").
export const claimedSuccess = (text: string): string | undefined => {
  const pattern = new RegExp(CLAIM.source, 'gi')
  for (const match of text.matchAll(pattern)) {
    if (!NEGATED.test(text.slice(Math.max(0, (match.index ?? 0) - 40), match.index))) return match[0]
  }
  return undefined
}
