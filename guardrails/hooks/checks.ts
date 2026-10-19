export type CheckCommand = { label: string; argv: readonly string[] }

export type CheckRun = { label: string; exitCode: number; output: string }

const DEFAULT_SCRIPTS = ['typecheck', 'lint'] as const

export const tokenize = (command: string): string[] =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '')

export const packageManager = (files: ReadonlySet<string>): string => {
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('bun.lockb') || files.has('bun.lock')) return 'bun'
  if (files.has('yarn.lock')) return 'yarn'
  return 'npm'
}

const scriptNames = (packageJson: string | undefined): Set<string> => {
  if (packageJson === undefined) return new Set()
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts
    return new Set(scripts === undefined ? [] : Object.keys(scripts))
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
