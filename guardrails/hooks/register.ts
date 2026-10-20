import type { EngineInterface, PluginOptions, Register } from 'claude-code'
import { CHECK_ENV, composeFingerprint, isChangedOnly, resolveChecks, summarizeFailures, untrackedPaths, type CheckMode, type CheckRun } from './checks.ts'
import { addedPackages, declaredDependencies, isSourceFile, parentDirs, pathAliases, unresearchedPackages } from './imports.ts'
import { blockEntry, claimedSuccess, isCoverageConfig, isGitCommit, isLockfile, judgeCommand, judgeProse, judgeWeakening } from './rules.ts'
import { judgeOwnership, MARKER, parseMarker, type Marker } from './crew.ts'
import { draftSpec, judgeScope, parseSpec, SPEC_PATH, type Spec } from './spec.ts'

type Config = {
  stopGate: boolean
  promptRule: boolean
  draftSpecs: boolean
  writingGate: boolean
  researchHoldLines: number
  newTaskPercent: number
  allowImports: ReadonlySet<string>
  checkTimeoutMs: number
}

type GuardState = {
  isOff: boolean
  isDirty: boolean
  lastResult: 'pass' | 'fail' | undefined
  stopBlocks: number
  heldPrompt: { text: string; at: number } | undefined
  // Inputs of the session's non-edit tool calls (reads, searches, fetches), for the research-first hold.
  lookups: string[]
  heldWrites: Set<string>
  // Working-tree fingerprints (git): at the start of the turn, and when checks last passed.
  turnStartFp: string | undefined
  passFp: string | undefined
  // Whether the last passing run was the full suite (commits need that) or the end-of-turn subset.
  lastPassFull: boolean
  claimChecked: boolean
  warnedNoChecks: boolean
}

const MAX_STOP_BLOCKS = 2
const FAILURE_LINES = 30
const NEW_TASK_MIN_CHARS = 300
const SPEC_DRAFT_MIN_CHARS = 1500
const HELD_PROMPT_MS = 5 * 60_000
const SHIP_DELAY_MS = 100
const TYPED_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

const RULE =
  `Guardrails are on. Follow ${SPEC_PATH} exactly when it exists; edits outside its scope are blocked. ` +
  'Put out-of-scope ideas under "Suggestions:" (at most 3 bullets) instead of doing them. Be terse. ' +
  'Never invent APIs, packages, flags or file contents: read, grep or say you do not know. ' +
  "Unless the user asks for a custom build, prefer an established, widely used library or the existing API of one already in use; before building on a library, search its docs, examples and source; check a package exists and is maintained before adding it. " +
  'Checks must pass before you finish.'

const SHIP_PROMPT =
  'Ship the current work: commit the changes that belong to this task with a concise message in the repo style, ' +
  'push the branch, and open a draft PR that says what changed and why. Make no other changes. ' +
  'If any step fails, stop and report it.'

const REWORD = 'Reword it plainly (period, comma or parentheses instead of em dashes; plain words) and run it again.'

const MAX_LOOKUPS = 400
const LOOKUP_CHARS = 2_000
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])

const SUGGEST = 'If it needs changing, list it under "Suggestions:" in your reply.'

const state: GuardState = {
  isOff: false,
  isDirty: false,
  lastResult: undefined,
  stopBlocks: 0,
  heldPrompt: undefined,
  lookups: [],
  heldWrites: new Set(),
  turnStartFp: undefined,
  passFp: undefined,
  lastPassFull: false,
  claimChecked: false,
  warnedNoChecks: false,
}

const readConfig = (options: PluginOptions): Config => ({
  stopGate: options.stopGate !== false,
  promptRule: options.promptRule !== false,
  draftSpecs: options.draftSpecs !== false,
  writingGate: options.writingGate !== false,
  researchHoldLines:
    typeof options.researchHoldLines === 'number' && options.researchHoldLines >= 0 ? options.researchHoldLines : 150,
  newTaskPercent:
    typeof options.newTaskPercent === 'number' && options.newTaskPercent > 0 ? options.newTaskPercent : 75,
  allowImports: new Set(
    typeof options.allowImports === 'string'
      ? options.allowImports.split(',').map(name => name.trim()).filter(name => name !== '')
      : [],
  ),
  checkTimeoutMs:
    (typeof options.checkTimeoutMinutes === 'number' && options.checkTimeoutMinutes > 0
      ? options.checkTimeoutMinutes
      : 10) * 60_000,
})

const clip = (text: string, max = 80): string => (text.length <= max ? text : `${text.slice(0, max)}…`)

const isAbsolute = (path: string): boolean => /^([\\/]|[A-Za-z]:[\\/])/.test(path)

const absoluteIn = (root: string, path: string): string => (isAbsolute(path) ? path : `${root}/${path}`)

// Project-relative path with forward slashes, or undefined for a path outside the project.
const relativeTo = (root: string, path: string): string | undefined => {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = path.replace(/\\/g, '/')
  if (!isAbsolute(path)) return normalized.replace(/^\.\//, '')
  return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : undefined
}

const loadSpec = async ($: EngineInterface, root: string): Promise<Spec | undefined> => {
  const text = await $.fs.read(`${root}/${SPEC_PATH}`).catch(() => undefined)
  return typeof text === 'string' ? parseSpec(text) : undefined
}

const showStatus = ($: EngineInterface, spec: Spec | undefined): void => {
  if (state.isOff) return $.ui.status('guard off')
  const checks = state.lastResult === 'pass' ? '✓ checks' : state.lastResult === 'fail' ? '✗ checks' : 'checks –'
  const specPart = spec === undefined ? 'no spec' : `spec: ${spec.scope.length || 'any'} scope`
  $.ui.status(`guard · ${specPart} · ${checks}`)
}

const missingPackage = async (
  $: EngineInterface,
  config: Config,
  absolutePath: string,
  names: readonly string[],
): Promise<string | undefined> => {
  if (names.length === 0) return undefined
  const dirs = parentDirs(absolutePath)
  const declared = new Set<string>()
  const aliases: string[] = []
  let hasPackageJson = false
  for (const dir of dirs) {
    const packageJson = await $.fs.read(`${dir}/package.json`).catch(() => undefined)
    if (typeof packageJson === 'string') {
      hasPackageJson = true
      for (const name of declaredDependencies(packageJson)) declared.add(name)
    }
    const tsconfig = await $.fs.read(`${dir}/tsconfig.json`).catch(() => undefined)
    if (typeof tsconfig === 'string') aliases.push(...pathAliases(tsconfig))
  }
  if (!hasPackageJson) return undefined

  for (const name of names) {
    const isKnown =
      declared.has(name) ||
      config.allowImports.has(name) ||
      aliases.some(alias => alias !== '' && (name === alias || name.startsWith(`${alias}/`)))
    if (isKnown) continue
    let isInstalled = false
    for (const dir of dirs) {
      if (await $.fs.exists(`${dir}/node_modules/${name}/package.json`)) {
        isInstalled = true
        break
      }
    }
    if (!isInstalled) return name
  }
  return undefined
}

// A crew specialist's worktree carries a ticket marker at its root; the ticket, not the spec, decides what it may edit.
const findMarker = async ($: EngineInterface, absolutePath: string): Promise<{ root: string; marker: Marker } | undefined> => {
  for (const dir of parentDirs(absolutePath)) {
    if (!(await $.fs.exists(`${dir}/${MARKER}`))) continue
    const text = await $.fs.read(`${dir}/${MARKER}`).catch(() => undefined)
    const marker = typeof text === 'string' ? parseMarker(text) : undefined
    return marker === undefined ? undefined : { root: dir, marker }
  }
  return undefined
}

const isInCrewWorktree = async ($: EngineInterface, path: string): Promise<boolean> =>
  (await findMarker($, absoluteIn(await $.session.root(), path))) !== undefined

const judgeEdit = async (
  $: EngineInterface,
  config: Config,
  path: string,
  newCode: string,
  oldCode: string,
): Promise<string | undefined> => {
  const sessionRoot = await $.session.root()
  const crew = await findMarker($, absoluteIn(sessionRoot, path))
  const root = crew?.root ?? sessionRoot
  const relative = relativeTo(root, path)
  if (relative === undefined) return undefined

  if (isLockfile(relative)) {
    return `guardrails: don't hand-edit ${relative}. Change the manifest and let the package manager regenerate it.`
  }
  if (crew !== undefined) {
    const reason = judgeOwnership(relative, crew.marker)
    if (reason !== undefined) return `guardrails: ${reason}.`
  } else {
    const verdict = judgeScope(relative, await loadSpec($, root))
    if (!verdict.isAllowed) return `guardrails: ${verdict.reason}. Don't edit it. ${SUGGEST}`
  }
  if (!isSourceFile(relative) && !isCoverageConfig(relative)) return undefined

  const weakening = judgeWeakening(newCode, oldCode, relative)
  if (weakening !== undefined) {
    return `guardrails: this edit ${weakening}. Fix the cause instead. If it is truly needed, explain why under "Suggestions:" and let the user decide.`
  }
  if (!isSourceFile(relative)) return undefined
  const missing = await missingPackage($, config, absoluteIn(root, path), addedPackages(newCode, oldCode))
  if (missing !== undefined) {
    return `guardrails: '${missing}' is not installed or declared in any package.json above ${relative}. Don't guess packages: use an installed one, or propose adding it under "Suggestions:".`
  }
  return undefined
}

const rememberLookup = (input: unknown): void => {
  state.lookups = [...state.lookups, JSON.stringify(input).slice(0, LOOKUP_CHARS)].slice(-MAX_LOOKUPS)
}

// A large new file built on a library the session never looked at is often a hand-rolled copy of an API the library
// already has. Held once; writing it again goes through.
const holdForResearch = (config: Config, path: string, content: string): string | undefined => {
  if (config.researchHoldLines === 0 || !isSourceFile(path) || state.heldWrites.has(path)) return undefined
  const lines = content.split('\n').length
  if (lines < config.researchHoldLines) return undefined
  const names = unresearchedPackages(content, state.lookups, config.allowImports)
  if (names.length === 0) return undefined
  state.heldWrites.add(path)
  const list = names.map(name => `'${name}'`).join(', ')
  return (
    `guardrails: this new ${lines}-line file builds on ${list}, which this session has not looked up yet. ` +
    `Check for an existing API first: the docs, the examples in its repo, and its source under node_modules/${names[0]}. ` +
    'Prefer what the library already provides over custom code. If nothing fits, write the file again and it will go through.'
  )
}

type CheckOutcome = { failure: string | undefined; count: number }

// Changes to the working tree from any source, shell edits included. Undefined outside git or when the output was cut.
const fingerprint = async ($: EngineInterface): Promise<string | undefined> => {
  const root = await $.session.root()
  const git = (args: readonly string[], stdin?: string) =>
    $.process.run(['git', ...args], { cwd: root, timeoutMs: 15_000, ...(stdin === undefined ? {} : { stdin }) }).catch(() => undefined)
  if ((await git(['rev-parse', '--is-inside-work-tree']))?.exitCode !== 0) return undefined
  const [tree, diff, others] = await Promise.all([
    git(['rev-parse', 'HEAD^{tree}']),
    git(['diff', 'HEAD', '--no-color', '--no-ext-diff']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  if (diff?.isStdoutTruncated === true || others?.isStdoutTruncated === true) return undefined
  const untracked = untrackedPaths(others?.exitCode === 0 ? others.stdout : '')
  const blobs = untracked.length === 0 ? undefined : await git(['hash-object', '--stdin-paths'], untracked.join('\n'))
  return composeFingerprint(tree?.exitCode === 0 ? tree.stdout : '', diff?.exitCode === 0 ? diff.stdout : '', untracked, blobs?.stdout ?? '')
}

const isUnchanged = (current: string | undefined, needsFull = false): boolean =>
  (!needsFull || state.lastPassFull) && current !== undefined && state.lastResult === 'pass' && current === state.passFp

const MAX_BLOCK_LINES = 2000

// Shared with the other tools' runtime, so `doctor` counts every block, hold and send-back in one place.
const recordBlock = async ($: EngineInterface, tool: string, reason: string): Promise<void> => {
  try {
    const [modsHome, home, now] = await Promise.all([$.env.get('CLAUDE_MODS_HOME'), $.env.get('HOME'), $.clock.now()])
    const dir = modsHome ?? (home === undefined ? undefined : `${home}/.claude-mods`)
    if (dir === undefined) return
    const path = `${dir}/blocks.log`
    const current = await $.fs.read(path).catch(() => '')
    const lines = (typeof current === 'string' ? current : '').split('\n').filter(line => line !== '').slice(-MAX_BLOCK_LINES)
    await $.fs.write(path, `${[...lines, JSON.stringify(blockEntry(tool, reason, new Date(now)))].join('\n')}\n`)
  } catch {
    // Logging must never break a hook.
  }
}

const denied = async ($: EngineInterface, tool: string, deny: string): Promise<{ deny: string }> => {
  await recordBlock($, tool, deny)
  return { deny }
}

const runChecks = async ($: EngineInterface, config: Config, mode: CheckMode): Promise<CheckOutcome> => {
  const root = await $.session.root()
  const [spec, packageJson, entries] = await Promise.all([
    loadSpec($, root),
    $.fs.read(`${root}/package.json`).catch(() => undefined),
    $.fs.list(root).catch(() => []),
  ])
  const commands = resolveChecks(
    spec?.checks ?? [],
    typeof packageJson === 'string' ? packageJson : undefined,
    new Set(entries.map(entry => entry.name)),
    mode,
  )

  const runs: CheckRun[] = []
  for (const command of commands) {
    $.ui.status(`guard · running ${command.label}`)
    const ran = await $.process
      .run(command.argv, { cwd: root, timeoutMs: config.checkTimeoutMs, env: { ...CHECK_ENV } })
      .catch((error: unknown) => ({ exitCode: 127, stdout: '', stderr: String(error) }))
    runs.push({ label: command.label, exitCode: ran.exitCode, output: `${ran.stdout}\n${ran.stderr}` })
  }

  const failure = summarizeFailures(runs, FAILURE_LINES)
  state.lastResult = failure === '' ? 'pass' : 'fail'
  state.isDirty = failure !== ''
  state.passFp = failure === '' ? await fingerprint($) : undefined
  state.lastPassFull = failure === '' && (mode === 'full' || !commands.some(command => isChangedOnly(command.label)))
  showStatus($, spec)
  return { failure: failure === '' ? undefined : failure, count: commands.length }
}

const runChecksIfNeeded = async ($: EngineInterface, config: Config): Promise<string | undefined> => {
  if (!state.isDirty && state.lastResult === 'pass' && state.passFp === undefined) return undefined
  if (isUnchanged(await fingerprint($), true)) {
    state.isDirty = false
    return undefined
  }
  return (await runChecks($, config, 'full')).failure
}

const NO_CHECKS =
  'guardrails: this repo has no checks to run (no `checks:` in .claude/spec.md and no typecheck, lint or test script), so the end-of-turn gate passes without testing anything.'

// A reply that says tests pass, fixed or verified is held to the checks once per turn; unverified claims get them run now.
const judgeClaim = async ($: EngineInterface, config: Config, message: string | undefined, current: string | undefined): Promise<string | undefined> => {
  if (message === undefined || state.claimChecked) return undefined
  const claim = claimedSuccess(message)
  if (claim === undefined) return undefined
  state.claimChecked = true
  if (isUnchanged(current)) return undefined
  const wasDirty = state.isDirty
  const { failure } = await runChecks($, config, 'turn')
  // The claim gets one send-back; it doesn't arm the edit gate's retries on a turn that changed nothing.
  state.isDirty = wasDirty
  return failure === undefined
    ? undefined
    : `guardrails: your reply says "${claim}", but the checks fail. Correct the reply to say what actually passes and what doesn't (or fix it first).\n${failure}`
}

const holdNewTask = async ($: EngineInterface, config: Config, text: string): Promise<string | undefined> => {
  if (text.length < NEW_TASK_MIN_CHARS) return undefined
  const [{ context }, now] = await Promise.all([$.session.usage(), $.clock.now()])
  if ((context.percent ?? 0) < config.newTaskPercent) return undefined
  if (state.heldPrompt?.text === text && now - state.heldPrompt.at < HELD_PROMPT_MS) {
    state.heldPrompt = undefined
    return undefined
  }
  state.heldPrompt = { text, at: now }
  return (
    `guardrails: context is at ${context.percent}%. A new task here will thrash compaction. ` +
    '/clear first (then /handoff-load if you need the old thread), or send the same prompt again to go ahead.'
  )
}

const saveSpecDraft = async ($: EngineInterface, text: string): Promise<void> => {
  if (text.length < SPEC_DRAFT_MIN_CHARS) return
  const root = await $.session.root()
  const path = `${root}/${SPEC_PATH}`
  if (await $.fs.exists(path)) return
  await $.fs.write(path, draftSpec(text))
  $.ui.toast(`Saved your long prompt as ${SPEC_PATH}. Add scope: globs there to enforce it.`, { timeoutMs: 10_000 })
}

const guardStatusText = async ($: EngineInterface): Promise<string> => {
  const spec = await loadSpec($, await $.session.root())
  const lines = [
    state.isOff ? 'OFF for this session' : 'on',
    spec === undefined
      ? `no ${SPEC_PATH}: scope unrestricted`
      : `scope: ${spec.scope.join(', ') || 'anywhere'} · forbid: ${spec.forbid.join(', ') || 'none'} · checks: ${spec.checks.join(', ') || 'typecheck + lint + test'}`,
    `checks: ${state.lastResult ?? 'not run'}${state.isDirty ? ' (edits since)' : ''}`,
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const config = readConfig(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([
      $.command.register({ name: 'guard', description: 'Guardrails: status, or `on` / `off` for this session.', argumentHint: '[on|off]' }),
      $.command.register({ name: 'checks', description: 'Run the spec checks (or typecheck + lint + test) now.' }),
      $.command.register({ name: 'ship', description: 'Run checks; if they pass, commit, push and open a draft PR.' }),
    ])
    showStatus($, await loadSpec($, e.cwd))
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!config.promptRule) return result
    return { ...result, sections: [...result.sections, { id: 'guardrails:rule', text: RULE, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool)) rememberLookup(e)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (state.isOff) return next(e)
    const deny = await judgeEdit($, config, e.file_path, e.new_string, e.old_string)
    if (deny !== undefined) return denied($, 'Edit', deny)
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true && !(await isInCrewWorktree($, e.file_path))) state.isDirty = true
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guardrails: the edit check failed, so the edit is held.' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (state.isOff) return next(e)
    const isNew = !(await $.fs.exists(e.file_path))
    const existing = isNew ? '' : await $.fs.read(e.file_path).catch(() => '')
    const deny =
      (await judgeEdit($, config, e.file_path, e.content, typeof existing === 'string' ? existing : '')) ??
      (isNew ? holdForResearch(config, e.file_path, e.content) : undefined)
    if (deny !== undefined) return denied($, 'Write', deny)
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true && !(await isInCrewWorktree($, e.file_path))) state.isDirty = true
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guardrails: the write check failed, so the write is held.' }))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    if (state.isOff) return next(e)
    const deny = await judgeEdit($, config, e.notebook_path, e.new_source, '')
    if (deny !== undefined) return denied($, 'NotebookEdit', deny)
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) state.isDirty = true
    return result
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guardrails: the notebook check failed, so the edit is held.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (state.isOff) return next(e)
    const reason = judgeCommand(e.command)
    if (reason !== undefined) {
      return denied($, 'Bash', `guardrails: blocked \`${clip(e.command)}\`: ${reason}. If the user wants it, they can run it with !.`)
    }
    const prose = config.writingGate ? judgeProse(e.command) : undefined
    if (prose !== undefined) return denied($, 'Bash', `guardrails: ${prose}. ${REWORD}`)
    if (isGitCommit(e.command)) {
      const failure = await runChecksIfNeeded($, config)
      if (failure !== undefined) return denied($, 'Bash', `guardrails: commit blocked, checks fail:\n${failure}`)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'guardrails: the command check failed, so the command is held.' }))

  on('classic.Stop', async ($, e, next) => {
    if (state.isOff || !config.stopGate) return next(e)
    const current = await fingerprint($)
    const isChanged = state.isDirty || (current !== undefined && state.turnStartFp !== undefined && current !== state.turnStartFp)
    if (isChanged && isUnchanged(current)) {
      state.isDirty = false
      state.stopBlocks = 0
    } else if (isChanged) {
      const { failure, count } = await runChecks($, config, 'turn')
      if (failure === undefined) {
        state.stopBlocks = 0
        if (count === 0 && !state.warnedNoChecks) {
          state.warnedNoChecks = true
          $.ui.log(NO_CHECKS)
          await recordBlock($, 'Stop', NO_CHECKS)
        }
      } else if (state.stopBlocks >= MAX_STOP_BLOCKS) {
        state.stopBlocks = 0
        const gaveUp = `guardrails: checks still fail after ${MAX_STOP_BLOCKS} retries; stopping so you can decide.\n${failure}`
        $.ui.log(gaveUp)
        await recordBlock($, 'Stop', gaveUp)
      } else {
        state.stopBlocks += 1
        const block = `guardrails: checks fail; fix them before finishing (retry ${state.stopBlocks}/${MAX_STOP_BLOCKS}).\n${failure}`
        await recordBlock($, 'Stop', block)
        return { block }
      }
    }
    const claim = await judgeClaim($, config, e.last_assistant_message, current)
    if (claim === undefined) return next(e)
    await recordBlock($, 'Stop', claim)
    return { block: claim }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (state.isOff || e.command !== undefined || e.isMeta === true || !TYPED_ORIGINS.has(e.origin.kind)) return next(e)
    const hold = await holdNewTask($, config, e.text)
    if (hold !== undefined) {
      await recordBlock($, 'prompt', hold)
      return { drop: hold }
    }
    if (config.draftSpecs) await saveSpecDraft($, e.text)
    state.claimChecked = false
    if (config.stopGate) state.turnStartFp = await fingerprint($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'guard' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') state.isOff = true
    if (arg === 'on') state.isOff = false
    showStatus($, await loadSpec($, await $.session.root()))
    return { text: await guardStatusText($) }
  })

  on('command.run', { command: 'checks' }, async $ => {
    const { failure } = await runChecks($, config, 'full')
    return { text: failure === undefined ? '✓ checks pass' : `checks fail\n${failure}` }
  })

  on('command.run', { command: 'ship' }, async $ => {
    const { failure } = await runChecks($, config, 'full')
    if (failure !== undefined) return { text: `not shipping, checks fail\n${failure}` }
    // A command cannot start a turn while it holds this one; the timer submits once it has returned.
    $.clock.after(SHIP_DELAY_MS, () => {
      $.prompt.submit({ text: SHIP_PROMPT }).catch(error => $.ui.log(`guardrails: /ship could not start: ${String(error)}`))
    })
    return { text: '✓ checks pass, shipping.' }
  })
}
