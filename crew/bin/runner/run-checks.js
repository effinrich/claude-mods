import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveChecks, summarizeFailures } from "../core/checks.js";
const FAILURE_LINES = 30;
const readText = (path) => {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return undefined;
    }
};
// The given commands, or typecheck + lint from package.json when there are none. Undefined means everything passed.
export const runCheckCommands = (config, root, checks) => {
    const entries = (() => {
        try {
            return readdirSync(root);
        }
        catch {
            return [];
        }
    })();
    const commands = resolveChecks(checks, readText(join(root, 'package.json')), new Set(entries));
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
