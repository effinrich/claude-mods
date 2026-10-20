import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECK_ENV, composeFingerprint, isTestCommand, resolveChecks, summarizeFailures, untrackedPaths, type CheckRun } from '../core/checks.ts'
import type { Config } from './types.ts'

const FAILURE_LINES = 30

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export type CheckReport = { failure: string | undefined; labels: readonly string[] }

// The given commands, or typecheck + lint + test from package.json when there are none. Undefined means everything passed.
export const runCheckCommands = (config: Pick<Config, 'checkTimeoutMs'>, root: string, checks: readonly string[]): string | undefined =>
  runCheckReport(config, root, checks).failure

export const ranTests = (report: CheckReport): boolean => report.labels.some(isTestCommand)

export const runCheckReport = (config: Pick<Config, 'checkTimeoutMs'>, root: string, checks: readonly string[]): CheckReport => {
  const entries = (() => {
    try {
      return readdirSync(root)
    } catch {
      return []
    }
  })()
  const commands = resolveChecks(checks, readText(join(root, 'package.json')), new Set(entries))
  const runs: CheckRun[] = commands.map(command => {
    const [file = '', ...args] = command.argv
    const ran = spawnSync(file, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: config.checkTimeoutMs,
      env: { ...process.env, ...CHECK_ENV },
      shell: process.platform === 'win32',
      maxBuffer: 16 * 1024 * 1024,
    })
    const exitCode = ran.error !== undefined ? 127 : (ran.status ?? 1)
    return { label: command.label, exitCode, output: `${ran.stdout ?? ''}\n${ran.stderr ?? ''}${ran.error ? `\n${ran.error.message}` : ''}` }
  })
  const failure = summarizeFailures(runs, FAILURE_LINES)
  return { failure: failure === '' ? undefined : failure, labels: commands.map(command => command.label) }
}

const gitOut = (root: string, args: readonly string[], input?: string): string | undefined => {
  const ran = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  return ran.status === 0 ? ran.stdout : undefined
}

// Changes to the working tree from any source, shell edits included. Undefined outside a git repo.
export const workTreeFingerprint = (root: string): string | undefined => {
  if (gitOut(root, ['rev-parse', '--is-inside-work-tree']) === undefined) return undefined
  const tree = gitOut(root, ['rev-parse', 'HEAD^{tree}']) ?? ''
  const diff = gitOut(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff']) ?? gitOut(root, ['diff', '--cached', '--no-color']) ?? ''
  const untracked = untrackedPaths(gitOut(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
  const blobs = untracked.length === 0 ? '' : (gitOut(root, ['hash-object', '--stdin-paths'], untracked.join('\n')) ?? '')
  return composeFingerprint(tree, diff, untracked, blobs)
}
