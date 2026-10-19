import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveChecks, summarizeFailures } from "../core/checks.js";
import { diffSnapshots, snapshotFile } from "../core/drift.js";
import { renderHandoff } from "../core/handoff.js";
import { addedPackages, declaredDependencies, isSourceFile, parentDirs, pathAliases } from "../core/imports.js";
import { isGitCommit, isLockfile, judgeCommand, judgeWeakening } from "../core/rules.js";
import { draftSpec, judgeScope, parseSpec, SPEC_PATH } from "../core/spec.js";
import { handoffPath, loadState, log, modsHome, rememberPrompt, rememberTouched, saveState, writeJson, } from "./state.js";
import { ALLOW } from "./types.js";
const MAX_STOP_BLOCKS = 2;
const FAILURE_LINES = 30;
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
export const judgeEdits = (config, root, event) => {
    const spec = loadSpec(root);
    for (const edit of event.edits) {
        const rel = toRelative(root, edit.path);
        if (rel === undefined)
            continue;
        if (isLockfile(rel)) {
            return { kind: 'deny', reason: `guardrails: don't hand-edit ${rel}. Change the manifest and let the package manager regenerate it.` };
        }
        const verdict = judgeScope(rel, spec);
        if (!verdict.isAllowed)
            return { kind: 'deny', reason: `guardrails: ${verdict.reason}. Don't edit it. ${SUGGEST}` };
        if (!isSourceFile(rel))
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
export const runChecks = (config, root) => {
    const entries = (() => {
        try {
            return readdirSync(root);
        }
        catch {
            return [];
        }
    })();
    const commands = resolveChecks(loadSpec(root)?.checks ?? [], readText(join(root, 'package.json')), new Set(entries));
    const runs = commands.map(command => {
        const [file = '', ...args] = command.argv;
        const ran = spawnSync(file, args, {
            cwd: root,
            encoding: 'utf8',
            timeout: config.checkTimeoutMs,
            shell: process.platform === 'win32',
            maxBuffer: 16 * 1024 * 1024,
        });
        const exitCode = ran.error !== undefined ? 127 : (ran.status ?? 1);
        return { label: command.label, exitCode, output: `${ran.stdout ?? ''}\n${ran.stderr ?? ''}${ran.error ? `\n${ran.error.message}` : ''}` };
    });
    const failure = summarizeFailures(runs, FAILURE_LINES);
    return failure === '' ? undefined : failure;
};
const recordChecks = (state, failure) => {
    state.lastResult = failure === undefined ? 'pass' : 'fail';
    state.isDirty = failure !== undefined;
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
        return await decideWithState(tool, capabilities, config, event, root, state, now);
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
            if (verdict.kind === 'allow') {
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
            if (isGitCommit(event.command) && (state.isDirty || state.lastResult !== 'pass')) {
                const failure = runChecks(config, root);
                recordChecks(state, failure);
                if (failure !== undefined)
                    return { kind: 'deny', reason: `guardrails: commit blocked, checks fail:\n${failure}` };
            }
            return ALLOW;
        }
        case 'stop': {
            if (!config.mods.guardrails || !config.stopGate || !state.isDirty)
                return ALLOW;
            const failure = runChecks(config, root);
            recordChecks(state, failure);
            if (failure === undefined) {
                state.stopBlocks = 0;
                return ALLOW;
            }
            if (state.stopBlocks >= MAX_STOP_BLOCKS) {
                state.stopBlocks = 0;
                log(`checks still fail after ${MAX_STOP_BLOCKS} retries in ${root}`);
                return { kind: 'notice', text: `guardrails: checks still fail after ${MAX_STOP_BLOCKS} retries; stopping so you can decide.` };
            }
            state.stopBlocks += 1;
            return { kind: 'continue', reason: `guardrails: checks fail; fix them before finishing (retry ${state.stopBlocks}/${MAX_STOP_BLOCKS}).\n${failure}` };
        }
        case 'prompt': {
            rememberPrompt(state, event.text);
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
