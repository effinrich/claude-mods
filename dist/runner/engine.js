import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { diffSnapshots, snapshotFile } from "../core/drift.js";
import { judgeOwnership, MARKER, parseMarker } from "../core/crew.js";
import { renderHandoff } from "../core/handoff.js";
import { isChangedOnly } from "../core/checks.js";
import { runCheckCommands, runCheckReport, workTreeFingerprint } from "./run-checks.js";
import { addedPackages, declaredDependencies, isSourceFile, parentDirs, pathAliases } from "../core/imports.js";
import { claimedSuccess, isCoverageConfig, isGitCommit, isLockfile, judgeCommand, judgeProse, judgeWeakening } from "../core/rules.js";
import { draftSpec, judgeScope, parseSpec, SPEC_PATH } from "../core/spec.js";
import { handoffPath, logBlock, loadState, log, modsHome, rememberPrompt, rememberTouched, saveState, writeJson, } from "./state.js";
import { ALLOW } from "./types.js";
const MAX_STOP_BLOCKS = 2;
const SPEC_DRAFT_MIN_CHARS = 1500;
const SUGGEST = 'If it needs changing, list it under "Suggestions:" in your reply.';
const readText = (path) => {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
};
export const projectRoot = (cwd) => {
    for (const dir of [cwd, ...parentDirs(join(cwd, 'x'))])
        if (existsSync(join(dir, '.git')))
            return dir;
    return cwd;
};
const loadSpec = (root) => {
    const text = readText(join(root, SPEC_PATH));
    return text === undefined ? undefined : parseSpec(text);
};
const toRelative = (root, path) => {
    const absolute = isAbsolute(path) ? path : join(root, path);
    const rel = relative(root, absolute);
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel.split(sep).join('/');
};
const missingPackage = (config, absolutePath, names) => {
    if (names.length === 0)
        return undefined;
    const dirs = parentDirs(absolutePath);
    const declared = new Set();
    const aliases = [];
    let hasPackageJson = false;
    for (const dir of dirs) {
        const packageJson = readText(join(dir, 'package.json'));
        if (packageJson !== undefined) {
            hasPackageJson = true;
            for (const name of declaredDependencies(packageJson))
                declared.add(name);
        }
        const tsconfig = readText(join(dir, 'tsconfig.json'));
        if (tsconfig !== undefined)
            aliases.push(...pathAliases(tsconfig));
    }
    if (!hasPackageJson)
        return undefined;
    return names.find(name => !declared.has(name) &&
        !config.allowImports.includes(name) &&
        !aliases.some(alias => alias !== '' && (name === alias || name.startsWith(`${alias}/`))) &&
        !dirs.some(dir => existsSync(join(dir, 'node_modules', name, 'package.json'))));
};
// A crew specialist's worktree carries a ticket marker at its root; the ticket, not the spec, decides what it may edit.
export const findCrewMarker = (absolutePath) => {
    for (const dir of parentDirs(absolutePath)) {
        const text = readText(join(dir, MARKER));
        if (text === undefined)
            continue;
        const marker = parseMarker(text);
        return marker === undefined ? undefined : { root: dir, marker };
    }
    return undefined;
};
export const judgeEdits = (config, sessionRoot, event) => {
    const spec = loadSpec(sessionRoot);
    for (const edit of event.edits) {
        const crew = findCrewMarker(isAbsolute(edit.path) ? edit.path : join(sessionRoot, edit.path));
        const root = crew?.root ?? sessionRoot;
        const rel = toRelative(root, edit.path);
        if (rel === undefined)
            continue;
        if (isLockfile(rel)) {
            return { kind: 'deny', reason: `guardrails: don't hand-edit ${rel}. Change the manifest and let the package manager regenerate it.` };
        }
        const ownership = crew === undefined ? undefined : judgeOwnership(rel, crew.marker);
        if (ownership !== undefined)
            return { kind: 'deny', reason: `guardrails: ${ownership}.` };
        const verdict = crew === undefined ? judgeScope(rel, spec) : { isAllowed: true };
        if (!verdict.isAllowed)
            return { kind: 'deny', reason: `guardrails: ${verdict.reason}. Don't edit it. ${SUGGEST}` };
        if (!isSourceFile(rel) && !isCoverageConfig(rel))
            continue;
        const absolute = isAbsolute(edit.path) ? edit.path : join(root, edit.path);
        const oldText = edit.oldText ?? readText(absolute) ?? '';
        const weakening = judgeWeakening(edit.newText, oldText, rel);
        if (weakening !== undefined) {
            return {
                kind: 'deny',
                reason: `guardrails: this edit ${weakening}. Fix the cause instead. If it is truly needed, explain why under "Suggestions:" and let the user decide.`,
            };
        }
        if (!isSourceFile(rel))
            continue;
        const missing = missingPackage(config, absolute, addedPackages(edit.newText, oldText));
        if (missing !== undefined) {
            return {
                kind: 'deny',
                reason: `guardrails: '${missing}' is not installed or declared in any package.json above ${rel}. Don't guess packages: use an installed one, or propose adding it under "Suggestions:".`,
            };
        }
    }
    return ALLOW;
};
export const runChecks = (config, root) => runCheckCommands(config, root, loadSpec(root)?.checks ?? []);
const hashFile = (path) => {
    try {
        return createHash('sha256').update(readFileSync(path)).digest('hex');
    }
    catch {
        return 'missing';
    }
};
const touchedHashes = (state, root) => Object.fromEntries(state.touched.map(path => [path, hashFile(isAbsolute(path) ? path : join(root, path))]));
// Every edit lands in `touched`, so if none of those files differ from the last passing run, neither do the checks.
const isUnchangedSincePass = (state, root) => {
    const passed = state.passHashes;
    if (state.lastResult !== 'pass' || passed === undefined)
        return false;
    return Object.entries(touchedHashes(state, root)).every(([path, hash]) => passed[path] === hash);
};
const recordChecks = (state, root, failure) => {
    state.lastResult = failure === undefined ? 'pass' : 'fail';
    state.isDirty = failure !== undefined;
    state.passHashes = failure === undefined ? touchedHashes(state, root) : undefined;
    state.passFp = failure === undefined ? workTreeFingerprint(root) : undefined;
};
// With git, any change since the last pass counts, shell edits included; without it, only the edits the hooks saw.
const isUnchanged = (state, root, fingerprint, needsFull = false) => (!needsFull || state.lastPassFull) &&
    (fingerprint === undefined ? isUnchangedSincePass(state, root) : state.lastResult === 'pass' && fingerprint === state.passFp);
const runAndRecord = (config, root, state, mode) => {
    const report = runCheckReport(config, root, loadSpec(root)?.checks ?? [], mode);
    recordChecks(state, root, report.failure);
    state.lastPassFull = report.failure === undefined && (mode === 'full' || !report.labels.some(isChangedOnly));
    return { failure: report.failure, count: report.labels.length };
};
const NO_CHECKS = 'guardrails: this repo has no checks to run (no `checks:` in .claude/spec.md and no typecheck, lint or test script), so the end-of-turn gate passes without testing anything.';
const gateStop = (config, root, state, fingerprint) => {
    if (isUnchanged(state, root, fingerprint)) {
        state.isDirty = false;
        state.stopBlocks = 0;
        return ALLOW;
    }
    const { failure, count } = runAndRecord(config, root, state, 'turn');
    if (failure === undefined) {
        state.stopBlocks = 0;
        if (count > 0 || state.warnedNoChecks)
            return ALLOW;
        state.warnedNoChecks = true;
        return { kind: 'notice', text: NO_CHECKS };
    }
    if (state.stopBlocks >= MAX_STOP_BLOCKS) {
        state.stopBlocks = 0;
        log(`checks still fail after ${MAX_STOP_BLOCKS} retries in ${root}`);
        return { kind: 'notice', text: `guardrails: checks still fail after ${MAX_STOP_BLOCKS} retries; stopping so you can decide.` };
    }
    state.stopBlocks += 1;
    return { kind: 'continue', reason: `guardrails: checks fail; fix them before finishing (retry ${state.stopBlocks}/${MAX_STOP_BLOCKS}).\n${failure}` };
};
// A reply that says tests pass, fixed or verified is held to the checks once per turn; unverified claims get them run now.
const judgeClaim = (config, root, state, message, fingerprint) => {
    if (message === undefined || state.claimChecked)
        return undefined;
    const claim = claimedSuccess(message);
    if (claim === undefined)
        return undefined;
    state.claimChecked = true;
    const wasDirty = state.isDirty;
    const failure = isUnchanged(state, root, fingerprint) ? undefined : runAndRecord(config, root, state, 'turn').failure;
    // The claim gets one send-back; it doesn't arm the edit gate's retries on a turn that changed nothing.
    state.isDirty = wasDirty;
    if (failure === undefined)
        return undefined;
    return {
        kind: 'continue',
        reason: `guardrails: your reply says "${claim}", but the checks fail. Correct the reply to say what actually passes and what doesn't (or fix it first).\n${failure}`,
    };
};
const writeHandoff = (state, root, now) => {
    const text = renderHandoff({ originalTask: state.originalTask, recentAsks: state.prompts, plan: undefined, todos: [], filesTouched: state.touched }, now, root.split(/[\\/]/).at(-1) ?? 'project').replace('Load it in a fresh session with /handoff-load.', `Saved to ${handoffPath(root)}.`);
    mkdirSync(dirname(handoffPath(root)), { recursive: true });
    writeFileSync(handoffPath(root), text);
    return text;
};
// Global instruction and hook files per tool: a change there between sessions is worth a look.
const watchedFiles = (tool) => {
    const home = homedir();
    const byTool = {
        codex: ['.codex/AGENTS.md', '.codex/AGENTS.override.md', '.codex/hooks.json'],
        gemini: ['.gemini/GEMINI.md'],
        cursor: ['.cursor/hooks.json'],
        copilot: ['.copilot/copilot-instructions.md'],
    };
    return byTool[tool].map(path => join(home, path));
};
const checkDrift = async (tool) => {
    const files = {};
    for (const path of watchedFiles(tool)) {
        const text = readText(path);
        if (text !== undefined)
            files[path] = await snapshotFile(text);
    }
    const current = { files, plugins: [], hooksSha: '' };
    const snapshotPath = join(modsHome(), 'state', `drift-${tool}.json`);
    const stored = (() => {
        try {
            return JSON.parse(readFileSync(snapshotPath, 'utf8'));
        }
        catch {
            return undefined;
        }
    })();
    writeJson(snapshotPath, current);
    if (stored === undefined)
        return undefined;
    const changes = diffSnapshots(stored, current);
    return changes.length === 0 ? undefined : `claude-mods: global ${tool} files changed since last session:\n${changes.join('\n')}`;
};
export const decide = async (tool, capabilities, config, event, now) => {
    if (event.kind === 'ignore')
        return ALLOW;
    const root = projectRoot(event.cwd);
    const state = loadState(tool, event.sessionId);
    try {
        const verdict = await decideWithState(tool, capabilities, config, event, root, state, now);
        if (verdict.kind === 'deny' || verdict.kind === 'continue')
            logBlock(tool, verdict.reason, now);
        if (verdict.kind === 'notice' && verdict.text.startsWith('guardrails:'))
            logBlock(tool, verdict.text, now);
        return verdict;
    }
    finally {
        saveState(tool, event.sessionId, state);
    }
};
const decideWithState = async (tool, capabilities, config, event, root, state, now) => {
    switch (event.kind) {
        case 'edit': {
            if (!config.mods.guardrails)
                return ALLOW;
            const verdict = judgeEdits(config, root, event);
            const isCrewOnly = event.edits.every(edit => findCrewMarker(isAbsolute(edit.path) ? edit.path : join(root, edit.path)) !== undefined);
            if (verdict.kind === 'allow' && !isCrewOnly) {
                state.isDirty = true;
                rememberTouched(state, event.edits.map(edit => edit.path));
            }
            return verdict;
        }
        case 'edited': {
            if (config.mods.guardrails)
                state.isDirty = true;
            rememberTouched(state, event.paths);
            return ALLOW;
        }
        case 'shell': {
            if (!config.mods.guardrails)
                return ALLOW;
            const reason = judgeCommand(event.command);
            if (reason !== undefined) {
                const shown = event.command.length > 80 ? `${event.command.slice(0, 80)}…` : event.command;
                return { kind: 'deny', reason: `guardrails: blocked \`${shown}\`: ${reason}. If the user wants it, they can run it themselves.` };
            }
            const prose = config.writingGate ? judgeProse(event.command) : undefined;
            if (prose !== undefined) {
                return { kind: 'deny', reason: `guardrails: ${prose}. Reword it plainly (period, comma or parentheses instead of em dashes; plain words) and run it again.` };
            }
            if (isGitCommit(event.command) && (state.isDirty || state.lastResult !== 'pass' || state.passFp !== undefined)) {
                if (isUnchanged(state, root, workTreeFingerprint(root), true)) {
                    state.isDirty = false;
                    return ALLOW;
                }
                const { failure } = runAndRecord(config, root, state, 'full');
                if (failure !== undefined)
                    return { kind: 'deny', reason: `guardrails: commit blocked, checks fail:\n${failure}` };
            }
            return ALLOW;
        }
        case 'stop': {
            if (!config.mods.guardrails || !config.stopGate)
                return ALLOW;
            const fingerprint = workTreeFingerprint(root);
            const isChanged = state.isDirty || (fingerprint !== undefined && state.turnStartFp !== undefined && fingerprint !== state.turnStartFp);
            const gate = isChanged ? gateStop(config, root, state, fingerprint) : ALLOW;
            if (gate.kind === 'continue')
                return gate;
            return judgeClaim(config, root, state, event.lastMessage, fingerprint) ?? gate;
        }
        case 'prompt': {
            rememberPrompt(state, event.text);
            state.claimChecked = false;
            if (config.mods.guardrails && config.stopGate)
                state.turnStartFp = workTreeFingerprint(root);
            if (config.mods.guardrails && config.draftSpecs && event.text.length >= SPEC_DRAFT_MIN_CHARS && !existsSync(join(root, SPEC_PATH))) {
                mkdirSync(join(root, '.claude'), { recursive: true });
                writeFileSync(join(root, SPEC_PATH), draftSpec(event.text));
            }
            if (config.mods.compactionGuard && capabilities.promptContext && state.pendingHandoff !== undefined) {
                const text = state.pendingHandoff;
                state.pendingHandoff = undefined;
                return { kind: 'context', text: `Handoff saved before the last compaction:\n\n${text}` };
            }
            return ALLOW;
        }
        case 'precompact': {
            if (!config.mods.compactionGuard)
                return ALLOW;
            state.pendingHandoff = writeHandoff(state, root, now);
            return ALLOW;
        }
        case 'sessionStart': {
            const notes = [];
            // Codex says `compact`; tools that send no source get it back when the same session starts again.
            const isAfterCompaction = event.source === 'compact' || event.source === undefined;
            if (config.mods.compactionGuard && isAfterCompaction && state.pendingHandoff !== undefined) {
                notes.push(`Handoff saved before the last compaction:\n\n${state.pendingHandoff}`);
                state.pendingHandoff = undefined;
            }
            if (config.mods.contextAudit) {
                const drift = await checkDrift(tool);
                if (drift !== undefined)
                    notes.push(drift);
            }
            return notes.length === 0 ? ALLOW : { kind: 'context', text: notes.join('\n\n') };
        }
    }
};
