import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChangedOnly, resolveChecks } from "../core/checks.js";
import { parseSpec, SPEC_PATH } from "../core/spec.js";
import { runCheckReport, workTreeFingerprint } from "./run-checks.js";
import { loadConfig, modsHome } from "./state.js";
const DEBOUNCE_MS = 1_500;
const MAX_ROUNDS = 3;
const POLL_MS = 200;
const MAIN = fileURLToPath(new URL('./main.js', import.meta.url));
const readText = (path) => {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
};
const sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const key = (root) => createHash('sha256').update(root).digest('hex').slice(0, 12);
const resultPath = (root) => join(modsHome(), 'results', `${key(root)}.json`);
const lockPath = (root) => join(modsHome(), 'results', `${key(root)}.lock`);
const specChecks = (root) => {
    const text = readText(join(root, SPEC_PATH));
    return text === undefined ? [] : parseSpec(text).checks;
};
const isAlive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
const readLock = (root) => {
    try {
        const lock = JSON.parse(readFileSync(lockPath(root), 'utf8'));
        return isAlive(lock.pid) ? lock : undefined;
    }
    catch {
        return undefined;
    }
};
// `auto`: only when the end-of-turn run is the cheap changed-only one (a bare vitest or jest script).
export const isBackgroundOn = (config, root) => {
    if (config.backgroundChecks === 'off')
        return false;
    if (config.backgroundChecks === 'on')
        return true;
    return resolveChecks(specChecks(root), readText(join(root, 'package.json')), new Set(), 'turn').some(check => isChangedOnly(check.label));
};
export const triggerBackground = (root) => {
    if (readLock(root) !== undefined)
        return;
    try {
        spawn(process.execPath, [MAIN, 'background', root], { detached: true, stdio: 'ignore', env: process.env }).unref();
    }
    catch {
        // Without a background run the gate runs the checks itself.
    }
};
const takeLock = (root) => {
    mkdirSync(join(modsHome(), 'results'), { recursive: true });
    if (readLock(root) !== undefined)
        return false;
    rmSync(lockPath(root), { force: true });
    try {
        writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, fingerprint: undefined }), { flag: 'wx' });
        return true;
    }
    catch {
        return false;
    }
};
const setLock = (root, fingerprint) => writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, fingerprint }));
// The detached process: settle, run, and keep the result only if the tree did not change while the checks ran.
export const runBackground = (root) => {
    if (!takeLock(root))
        return 0;
    try {
        const config = loadConfig(root);
        for (let round = 0; round < MAX_ROUNDS; round++) {
            sleep(DEBOUNCE_MS);
            const fingerprint = workTreeFingerprint(root);
            if (fingerprint === undefined)
                return 0;
            const stored = readStored(root);
            if (stored?.fingerprint === fingerprint)
                return 0;
            setLock(root, fingerprint);
            const report = runCheckReport(config, root, specChecks(root), 'turn');
            if (workTreeFingerprint(root) === fingerprint) {
                writeFileSync(resultPath(root), `${JSON.stringify({ ...report, fingerprint })}\n`);
                return 0;
            }
        }
        return 0;
    }
    finally {
        rmSync(lockPath(root), { force: true });
    }
};
const readStored = (root) => {
    try {
        return JSON.parse(readFileSync(resultPath(root), 'utf8'));
    }
    catch {
        return undefined;
    }
};
// A finished result for this exact tree, waiting for a run on this tree that is still going. Undefined: run it yourself.
export const backgroundResult = (root, fingerprint, timeoutMs) => {
    if (fingerprint === undefined)
        return undefined;
    const started = Date.now();
    for (;;) {
        const stored = readStored(root);
        if (stored?.fingerprint === fingerprint)
            return { failure: stored.failure ?? undefined, labels: stored.labels };
        const lock = readLock(root);
        if (lock === undefined || (lock.fingerprint !== undefined && lock.fingerprint !== fingerprint))
            return undefined;
        if (Date.now() - started > timeoutMs)
            return undefined;
        sleep(POLL_MS);
    }
};
