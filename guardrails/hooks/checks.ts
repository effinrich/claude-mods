// Generated from core/checks.ts by scripts/sync-core.mjs. Edit core/checks.ts, then run the script.
export type CheckCommand = { label: string; argv: readonly string[] }

export type CheckRun = { label: string; exitCode: number; output: string }

const DEFAULT_SCRIPTS = ['typecheck', 'lint', 'test'] as const

export const tokenize = (command: string): string[] =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '')

export const packageManager = (files: ReadonlySet<string>): string => {
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun'
  if (files.has('yarn.lock')) return 'yarn'
  return 'npm'
}

// npm init's placeholder test script always fails, so it doesn't count as a check.
const isPlaceholder = (command: unknown): boolean => typeof command === 'string' && /no test specified/.test(command)

const scriptNames = (packageJson: string | undefined): Set<string> => {
  if (packageJson === undefined) return new Set()
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {}
    return new Set(Object.keys(scripts).filter(name => !isPlaceholder(scripts[name])))
  } catch {
    return new Set()
  }
}

export const resolveChecks = (
  specChecks: readonly string[],
  packageJson: string | undefined,
  rootFiles: ReadonlySet<string>,
): CheckCommand[] => {
  if (specChecks.length > 0) return specChecks.map(command => ({ label: command, argv: tokenize(command) }))
  const scripts = scriptNames(packageJson)
  const manager = packageManager(rootFiles)
  return DEFAULT_SCRIPTS.filter(name => scripts.has(name)).map(name => ({
    label: `${manager} run ${name}`,
    argv: [manager, 'run', name],
  }))
}

export const summarizeFailures = (runs: readonly CheckRun[], lines: number): string =>
  runs
    .filter(run => run.exitCode !== 0)
    .map(run => {
      const tail = run.output.trimEnd().split('\n').slice(-lines).join('\n')
      return `✗ ${run.label} (exit ${run.exitCode})\n${tail}`
    })
    .join('\n\n')

export const isTestCommand = (label: string): boolean => /\b(test|tests|vitest|jest|mocha|ava|playwright|cypress|pytest|go test|cargo test)\b/.test(label)

// Test runners that default to watch mode run once when CI is set.
export const CHECK_ENV: Readonly<Record<string, string>> = { CI: 'true' }

// Untracked files that belong elsewhere: Claude Code's subagent worktrees live inside the repo.
export const untrackedPaths = (lsFilesZ: string): string[] =>
  lsFilesZ
    .split('\0')
    .filter(path => path !== '' && !path.startsWith('.claude/worktrees/'))
    .slice(0, 2000)

// Not cryptographic: two FNV-1a lanes, enough to tell whether the working tree changed.
export const hashText = (text: string): string => {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

export const composeFingerprint = (tree: string, diff: string, untracked: readonly string[], blobs: string): string =>
  hashText([tree, diff, untracked.join('\0'), blobs].join('\n\0\n'))
