import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_CONFIG } from "./types.js";
const MAX_PROMPTS = 8;
const MAX_TOUCHED = 25;
const STATE_TTL_MS = 7 * 24 * 60 * 60_000;
export const modsHome = () => process.env.CLAUDE_MODS_HOME ?? join(homedir(), '.claude-mods');
const emptyState = () => ({
    isDirty: false,
    lastResult: undefined,
    passHashes: undefined,
    stopBlocks: 0,
    originalTask: undefined,
    prompts: [],
    touched: [],
    pendingHandoff: undefined,
});
const readJson = (path) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return undefined;
    }
};
export const writeJson = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const statePath = (tool, sessionId) => join(modsHome(), 'state', `${tool}-${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'default'}.json`);
export const loadState = (tool, sessionId) => ({
    ...emptyState(),
    ...readJson(statePath(tool, sessionId)),
});
export const saveState = (tool, sessionId, state) => writeJson(statePath(tool, sessionId), state);
export const rememberPrompt = (state, text) => {
    state.originalTask ??= text;
    state.prompts = [...state.prompts, text].slice(-MAX_PROMPTS);
};
export const rememberTouched = (state, paths) => {
    state.touched = [...new Set([...paths, ...state.touched])].slice(0, MAX_TOUCHED);
};
export const loadConfig = () => {
    const stored = readJson(join(modsHome(), 'config.json'));
    return { ...DEFAULT_CONFIG, ...stored, mods: { ...DEFAULT_CONFIG.mods, ...stored?.mods } };
};
export const handoffPath = (root) => {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 6);
    return join(modsHome(), 'handoffs', `${basename(root) || 'project'}-${hash}.md`);
};
export const pruneOldState = (now) => {
    const dir = join(modsHome(), 'state');
    if (!existsSync(dir))
        return;
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try {
            if (now - statSync(path).mtimeMs > STATE_TTL_MS)
                unlinkSync(path);
        }
        catch {
            // A file another hook removed first is fine.
        }
    }
};
export const log = (line) => {
    try {
        mkdirSync(modsHome(), { recursive: true });
        writeFileSync(join(modsHome(), 'hook.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
    }
    catch {
        // Logging must never break a hook.
    }
};
