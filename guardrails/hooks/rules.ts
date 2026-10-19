// Generated from core/rules.ts by scripts/sync-core.mjs. Edit core/rules.ts, then run the script.
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
]

const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/

export const isLockfile = (path: string): boolean => LOCKFILES.test(path)

// Only what the edit adds counts, so touching a file that already has a suppression is fine.
export const judgeWeakening = (newCode: string, oldCode: string, path: string): string | undefined => {
  const isTypeScript = /\.(c|m)?tsx?$/.test(path)
  for (const rule of WEAKENING) {
    if (rule.isTypeScriptOnly === true && !isTypeScript) continue
    const count = (code: string): number => code.split('\n').filter(line => rule.pattern.test(line)).length
    if (count(newCode) > count(oldCode)) return rule.reason
  }
  return undefined
}
