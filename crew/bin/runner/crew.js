import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CREW_DIR, DEFAULT_CAP, frontier, MARKER, outsideOwnership, parsePlan, parseTicket, validateGraph, } from "../core/crew.js";
import { packageManager } from "../core/checks.js";
import { runCheckCommands } from "./run-checks.js";
import { loadConfig, loadProfile } from "./state.js";
const MAX_ATTEMPTS = 2;
const LOCK_WAIT_MS = 15_000;
class CrewError extends Error {
}
const git = (cwd, args) => {
    const ran = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return { ok: ran.status === 0, out: `${ran.stdout ?? ''}${ran.status === 0 ? '' : (ran.stderr ?? '')}`.trim() };
};
const gitOrThrow = (cwd, args) => {
    const result = git(cwd, args);
    if (!result.ok)
        throw new CrewError(`git ${args.join(' ')} failed: ${result.out}`);
    return result.out;
};
// The main checkout, also when called from inside one of its worktrees.
const mainRoot = (cwd) => {
    const common = gitOrThrow(cwd, ['rev-parse', '--git-common-dir']);
    return dirname(isAbsolute(common) ? common : resolve(cwd, common));
};
const featureDir = (root, feature) => join(root, CREW_DIR, feature);
const statePath = (root, feature) => join(featureDir(root, feature), 'state.json');
const loadPlan = (root, feature) => {
    const dir = featureDir(root, feature);
    const planFile = join(dir, 'plan.md');
    const ticketDir = join(dir, 'tickets');
    if (!existsSync(planFile) || !existsSync(ticketDir))
        throw new CrewError(`no plan: expected ${planFile} and ${ticketDir}/ (run /crew-plan first)`);
    const tickets = readdirSync(ticketDir)
        .filter(name => name.endsWith('.md'))
        .sort()
        .map(name => parseTicket(name.replace(/\.md$/, ''), readFileSync(join(ticketDir, name), 'utf8')));
    return { plan: parsePlan(readFileSync(planFile, 'utf8')), tickets };
};
const readState = (root, feature) => {
    try {
        return JSON.parse(readFileSync(statePath(root, feature), 'utf8'));
    }
    catch {
        throw new CrewError(`no crew run for ${feature} yet (run: crew init ${feature})`);
    }
};
const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
// Several specialists claim at once, so every state change happens under a lock directory.
const withState = (root, feature, change) => {
    const lock = `${statePath(root, feature)}.lock`;
    const started = Date.now();
    for (;;) {
        try {
            mkdirSync(lock);
            break;
        }
        catch {
            if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_WAIT_MS)
                rmSync(lock, { recursive: true, force: true });
            if (Date.now() - started > LOCK_WAIT_MS * 2)
                throw new CrewError(`state is locked (${lock}); remove it if no crew command is running`);
            sleep(50);
        }
    }
    try {
        const state = readState(root, feature);
        const result = change(state);
        writeFileSync(statePath(root, feature), `${JSON.stringify(state, null, 2)}\n`);
        return result;
    }
    finally {
        rmSync(lock, { recursive: true, force: true });
    }
};
const capOf = (root, plan) => plan.cap ?? loadProfile(root).crewCap ?? DEFAULT_CAP;
const ticketOf = (tickets, id) => {
    const ticket = tickets.find(candidate => candidate.id === id);
    if (ticket === undefined)
        throw new CrewError(`no ticket ${id}`);
    return ticket;
};
const statuses = (state) => Object.fromEntries(Object.entries(state.tickets).map(([id, ticket]) => [id, ticket.status]));
const readJson = (path) => {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
};
const baseRefOf = (path) => readJson(path).worktree?.baseRef;
// Subagent worktrees branch from the default branch unless worktree.baseRef is "head"; crew needs them on the run branch.
const ensureHeadBase = (root, out) => {
    const files = [join(root, '.claude', 'settings.local.json'), join(root, '.claude', 'settings.json'), join(homedir(), '.claude', 'settings.json')];
    const set = files.map(baseRefOf).find(value => value !== undefined);
    if (set === 'head')
        return;
    if (set !== undefined)
        throw new CrewError(`worktree.baseRef is ${JSON.stringify(set)}; crew needs "head" so specialists branch from the run branch`);
    const local = files[0] ?? '';
    const settings = readJson(local);
    settings.worktree = { ...settings.worktree, baseRef: 'head' };
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, `${JSON.stringify(settings, null, 2)}\n`);
    out(`  set worktree.baseRef = "head" in ${local}, so specialist worktrees branch from the run branch`);
};
const excludeRunFiles = (root) => {
    const common = gitOrThrow(root, ['rev-parse', '--git-common-dir']);
    const exclude = join(isAbsolute(common) ? common : resolve(root, common), 'info', 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const lines = [MARKER, `${CREW_DIR}/*/state.json`, `${CREW_DIR}/*/state.json.lock`].filter(line => !current.split('\n').includes(line));
    if (lines.length === 0)
        return;
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`);
};
const trackedChanges = (cwd) => gitOrThrow(cwd, ['status', '--porcelain'])
    .split('\n')
    .filter(line => line !== '' && !line.startsWith('??'));
const describeTicket = (ticket) => `${ticket.id}  [${ticket.role}]  owns: ${ticket.owns.join(', ') || '(nothing)'}`;
const printNext = (root, feature, out) => {
    const { plan, tickets } = loadPlan(root, feature);
    const state = readState(root, feature);
    const ready = frontier(tickets, statuses(state), capOf(root, plan));
    const counts = Object.values(state.tickets).reduce((all, ticket) => ({ ...all, [ticket.status]: (all[ticket.status] ?? 0) + 1 }), {});
    out(`  ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(', ')}`);
    if (ready.length > 0)
        out(`  ready now: ${ready.map(ticket => ticket.id).join(', ')} (run: crew next ${feature})`);
};
const init = (cwd, feature, out) => {
    const root = mainRoot(cwd);
    const { plan, tickets } = loadPlan(root, feature);
    const { errors, warnings } = validateGraph(tickets, plan);
    for (const warning of warnings)
        out(`  warning: ${warning}`);
    if (errors.length > 0) {
        for (const error of errors)
            out(`  error: ${error}`);
        return 1;
    }
    if (existsSync(statePath(root, feature)))
        throw new CrewError(`a run for ${feature} already exists (${statePath(root, feature)})`);
    const dirty = trackedChanges(root).filter(line => !line.slice(3).startsWith(`${CREW_DIR}/${feature}/`));
    if (dirty.length > 0)
        throw new CrewError(`commit or stash your changes first:\n${dirty.join('\n')}`);
    const base = gitOrThrow(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = `crew/${feature}`;
    gitOrThrow(root, ['switch', '-c', branch]);
    excludeRunFiles(root);
    ensureHeadBase(root, out);
    writeFileSync(statePath(root, feature), `${JSON.stringify({ feature, branch, base, tickets: Object.fromEntries(tickets.map(ticket => [ticket.id, { status: 'queued', attempts: 0 }])) }, null, 2)}\n`);
    gitOrThrow(root, ['add', '--', join(CREW_DIR, feature)]);
    if (!git(root, ['diff', '--cached', '--quiet']).ok)
        gitOrThrow(root, ['commit', '-m', `crew: plan ${feature}`]);
    out(`crew ${feature}: ${tickets.length} tickets on branch ${branch} (from ${base}), up to ${capOf(root, plan)} at once`);
    printNext(root, feature, out);
    return 0;
};
const next = (cwd, feature, cap, out) => {
    const root = mainRoot(cwd);
    const { plan, tickets } = loadPlan(root, feature);
    const ready = withState(root, feature, state => {
        const picked = frontier(tickets, statuses(state), cap ?? capOf(root, plan));
        for (const ticket of picked)
            state.tickets[ticket.id] = { ...state.tickets[ticket.id], status: 'running', attempts: state.tickets[ticket.id]?.attempts ?? 0 };
        return picked;
    });
    if (ready.length === 0) {
        out('nothing ready to start');
        printNext(root, feature, out);
        return 0;
    }
    out(`start these now, each with its role's agent (crew:<role>), all in parallel:`);
    for (const ticket of ready)
        out(`  ${describeTicket(ticket)}`);
    return 0;
};
const defaultSetup = (worktree) => {
    if (!existsSync(join(worktree, 'package.json')))
        return undefined;
    const files = new Set(readdirSync(worktree));
    const manager = packageManager(files);
    if (manager === 'pnpm')
        return 'pnpm install --frozen-lockfile --prefer-offline';
    if (manager === 'bun')
        return 'bun install --frozen-lockfile';
    if (manager === 'yarn')
        return 'yarn install --frozen-lockfile';
    return files.has('package-lock.json') ? 'npm ci --prefer-offline --no-audit --no-fund' : 'npm install --no-audit --no-fund';
};
const claim = (cwd, feature, id, out) => {
    const root = mainRoot(cwd);
    const worktree = gitOrThrow(cwd, ['rev-parse', '--show-toplevel']);
    if (resolve(worktree) === resolve(root))
        throw new CrewError('claim runs inside your own worktree, not the main checkout (is the agent isolated?)');
    const { plan, tickets } = loadPlan(root, feature);
    const ticket = ticketOf(tickets, id);
    const state = readState(root, feature);
    for (const blocker of ticket.blockedBy) {
        const sha = state.tickets[blocker]?.mergedSha;
        if (sha === undefined || !git(worktree, ['merge-base', '--is-ancestor', sha, 'HEAD']).ok) {
            throw new CrewError(`this worktree does not contain ${blocker}; it must branch from ${state.branch} (worktree.baseRef "head")`);
        }
    }
    const branch = gitOrThrow(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
    withState(root, feature, current => {
        const entry = current.tickets[id];
        if (entry?.status !== 'running')
            throw new CrewError(`${id} is ${entry?.status ?? 'unknown'}, not started by the lead`);
        current.tickets[id] = { ...entry, worktree, branch };
    });
    const marker = { feature, ticket: id, owns: ticket.owns, shared: plan.shared };
    writeFileSync(join(worktree, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    const setup = plan.setup === 'none' ? undefined : (plan.setup ?? defaultSetup(worktree));
    if (setup !== undefined) {
        out(`setup: ${setup}`);
        const ran = spawnSync(setup, { cwd: worktree, shell: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        if (ran.status !== 0)
            out(`setup failed (exit ${ran.status}):\n${`${ran.stdout}\n${ran.stderr}`.trim().split('\n').slice(-20).join('\n')}`);
    }
    out(`claimed ${id} in ${worktree} (branch ${branch})`);
    out(`you may edit only: ${ticket.owns.join(', ')}`);
    out(`checks: ${ticket.checks.join(' && ') || 'typecheck + lint + test'}`);
    const skills = [loadProfile(root).roles?.[ticket.role], loadProfile(root).skills].filter((list) => list !== undefined && list.trim() !== '');
    if (skills.length > 0)
        out(`skills: ${skills.join(', ')} (invoke each with the Skill tool before editing; skip any that isn't installed)`);
    out('');
    out(ticket.body);
    return 0;
};
const changedFiles = (cwd, from, to) => gitOrThrow(cwd, ['diff', '--name-only', `${from}...${to}`])
    .split('\n')
    .filter(line => line !== '');
// Commits whatever the specialist left uncommitted, so the merge sees all of it (the marker stays out via info/exclude).
const commitLeftovers = (worktree, ticket) => {
    if (gitOrThrow(worktree, ['status', '--porcelain']) === '')
        return;
    gitOrThrow(worktree, ['add', '-A']);
    gitOrThrow(worktree, ['commit', '-m', `crew: ${ticket.id} ${ticket.title}`]);
};
const verifyWorktree = (root, state, plan, ticket, entry) => {
    const worktree = entry.worktree;
    if (worktree === undefined || entry.branch === undefined || !existsSync(worktree))
        return `${ticket.id} has no claimed worktree`;
    commitLeftovers(worktree, ticket);
    const files = changedFiles(root, state.branch, entry.branch);
    const { shared, foreign } = outsideOwnership(files, { owns: ticket.owns, shared: plan.shared });
    if (shared.length > 0 || foreign.length > 0) {
        return `edits outside the ticket: ${[...shared.map(path => `${path} (shared)`), ...foreign].join(', ')}`;
    }
    if (files.length === 0)
        return undefined;
    const failure = runCheckCommands(loadConfig(), worktree, ticket.checks);
    return failure === undefined ? undefined : `ticket checks fail:\n${failure}`;
};
const check = (cwd, feature, id, out) => {
    const root = mainRoot(cwd);
    const { plan, tickets } = loadPlan(root, feature);
    const state = readState(root, feature);
    const entry = state.tickets[id];
    if (entry === undefined)
        throw new CrewError(`no ticket ${id}`);
    const problem = verifyWorktree(root, state, plan, ticketOf(tickets, id), entry);
    out(problem === undefined ? `✓ ${id} is ready to merge` : `✗ ${id}: ${problem}`);
    return problem === undefined ? 0 : 1;
};
const fail = (root, feature, id, reason, out) => {
    const attempts = withState(root, feature, state => {
        const entry = state.tickets[id];
        if (entry === undefined)
            return 0;
        state.tickets[id] = { ...entry, status: 'failed', attempts: entry.attempts + 1, reason };
        return entry.attempts + 1;
    });
    out(`✗ ${id} not merged: ${reason}`);
    out(attempts >= MAX_ATTEMPTS
        ? `  ${id} has failed ${attempts} times. Stop and report it to the user.`
        : `  Send the specialist back to fix it in the same worktree, then merge again, or: crew retry ${feature} ${id}`);
    return 1;
};
const merge = (cwd, feature, id, out) => {
    const root = mainRoot(cwd);
    const { plan, tickets } = loadPlan(root, feature);
    const ticket = ticketOf(tickets, id);
    const state = readState(root, feature);
    const entry = state.tickets[id];
    if (entry === undefined || (entry.status !== 'running' && entry.status !== 'failed'))
        throw new CrewError(`${id} is ${entry?.status ?? 'unknown'}`);
    if (gitOrThrow(root, ['rev-parse', '--abbrev-ref', 'HEAD']) !== state.branch)
        throw new CrewError(`check out ${state.branch} in the main checkout first`);
    if (trackedChanges(root).length > 0)
        throw new CrewError('commit the lead\'s own changes (shared files) before merging');
    const problem = verifyWorktree(root, state, plan, ticket, entry);
    if (problem !== undefined)
        return fail(root, feature, id, problem, out);
    const branch = entry.branch ?? '';
    if (changedFiles(root, state.branch, branch).length > 0) {
        const merged = git(root, ['merge', '--no-ff', '--no-edit', '-m', `crew: ${id} ${ticket.title}`, branch]);
        if (!merged.ok) {
            git(root, ['merge', '--abort']);
            return fail(root, feature, id, `merge conflict:\n${merged.out}`, out);
        }
        const failure = runCheckCommands(loadConfig(), root, plan.checks);
        if (failure !== undefined) {
            gitOrThrow(root, ['reset', '--keep', 'ORIG_HEAD']);
            return fail(root, feature, id, `checks fail after merging, so the merge was undone:\n${failure}`, out);
        }
    }
    const mergedSha = gitOrThrow(root, ['rev-parse', 'HEAD']);
    withState(root, feature, current => {
        current.tickets[id] = { status: 'merged', attempts: entry.attempts, mergedSha };
    });
    git(root, ['worktree', 'remove', '--force', entry.worktree ?? '']);
    git(root, ['branch', '-D', branch]);
    out(`✓ merged ${id} into ${state.branch}`);
    printNext(root, feature, out);
    return 0;
};
const retry = (cwd, feature, id, out) => {
    const root = mainRoot(cwd);
    withState(root, feature, state => {
        const entry = state.tickets[id];
        if (entry === undefined || entry.status === 'merged')
            throw new CrewError(`${id} is ${entry?.status ?? 'unknown'}`);
        if (entry.worktree !== undefined)
            git(root, ['worktree', 'remove', '--force', entry.worktree]);
        if (entry.branch !== undefined)
            git(root, ['branch', '-D', entry.branch]);
        state.tickets[id] = { status: 'queued', attempts: entry.attempts };
    });
    out(`${id} is queued again`);
    return 0;
};
const status = (cwd, feature, out) => {
    const root = mainRoot(cwd);
    const { tickets } = loadPlan(root, feature);
    const state = readState(root, feature);
    out(`crew ${feature} on ${state.branch} (from ${state.base})`);
    for (const ticket of tickets) {
        const entry = state.tickets[ticket.id];
        const extra = entry?.reason === undefined ? '' : `: ${entry.reason.split('\n')[0]}`;
        out(`  ${(entry?.status ?? 'queued').padEnd(8)} ${describeTicket(ticket)}${extra}`);
    }
    printNext(root, feature, out);
    const isDone = tickets.every(ticket => state.tickets[ticket.id]?.status === 'merged');
    if (isDone)
        out(`all merged. Push ${state.branch} and open a draft PR (/ship does both after the checks pass).`);
    return 0;
};
const validate = (cwd, feature, out) => {
    const root = mainRoot(cwd);
    const { plan, tickets } = loadPlan(root, feature);
    const { errors, warnings } = validateGraph(tickets, plan);
    for (const warning of warnings)
        out(`warning: ${warning}`);
    for (const error of errors)
        out(`error: ${error}`);
    if (errors.length === 0)
        out(`✓ ${tickets.length} tickets, up to ${capOf(root, plan)} at once`);
    return errors.length === 0 ? 0 : 1;
};
export const CREW_USAGE = `usage: crew <command> <feature> [ticket]

  validate <feature>        check the plan and tickets in ${CREW_DIR}/<feature>/
  init <feature>            validate, create branch crew/<feature>, start the run
  next <feature> [--cap N]  mark the tickets that can start now as running and list them
  claim <feature> <id>      (specialist, in its worktree) take the ticket and set up the worktree
  check <feature> <id>      ownership + ticket checks for a ticket's worktree
  merge <feature> <id>      (lead) verify, merge into crew/<feature>, run the plan checks, undo on failure
  retry <feature> <id>      drop a ticket's worktree and queue it again
  status <feature>          every ticket's state`;
export const runCrew = (args, cwd, out) => {
    const [command, feature, id] = args.filter(arg => !arg.startsWith('--'));
    const capFlag = args.indexOf('--cap');
    const cap = capFlag === -1 ? undefined : Number(args[capFlag + 1]);
    const needsId = ['claim', 'check', 'merge', 'retry'].includes(command ?? '');
    if (feature === undefined || !/^[\w.-]+$/.test(feature) || (needsId && id === undefined)) {
        out(CREW_USAGE);
        return 2;
    }
    try {
        switch (command) {
            case 'validate':
                return validate(cwd, feature, out);
            case 'init':
                return init(cwd, feature, out);
            case 'next':
                return next(cwd, feature, cap !== undefined && Number.isInteger(cap) && cap > 0 ? cap : undefined, out);
            case 'claim':
                return claim(cwd, feature, id ?? '', out);
            case 'check':
                return check(cwd, feature, id ?? '', out);
            case 'merge':
                return merge(cwd, feature, id ?? '', out);
            case 'retry':
                return retry(cwd, feature, id ?? '', out);
            case 'status':
                return status(cwd, feature, out);
            default:
                out(CREW_USAGE);
                return 2;
        }
    }
    catch (error) {
        if (error instanceof CrewError) {
            out(`crew: ${error.message}`);
            return 1;
        }
        throw error;
    }
};
