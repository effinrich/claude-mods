const DEFAULT_SCRIPTS = ['typecheck', 'lint', 'test'];
export const tokenize = (command) => [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
export const packageManager = (files) => {
    if (files.has('pnpm-lock.yaml'))
        return 'pnpm';
    if (files.has('bun.lockb') || files.has('bun.lock'))
        return 'bun';
    if (files.has('yarn.lock'))
        return 'yarn';
    return 'npm';
};
// npm init's placeholder test script always fails, so it doesn't count as a check.
const isPlaceholder = (command) => typeof command === 'string' && /no test specified/.test(command);
const scriptNames = (packageJson) => {
    if (packageJson === undefined)
        return new Set();
    try {
        const scripts = JSON.parse(packageJson).scripts ?? {};
        return new Set(Object.keys(scripts).filter(name => !isPlaceholder(scripts[name])));
    }
    catch {
        return new Set();
    }
};
export const resolveChecks = (specChecks, packageJson, rootFiles) => {
    if (specChecks.length > 0)
        return specChecks.map(command => ({ label: command, argv: tokenize(command) }));
    const scripts = scriptNames(packageJson);
    const manager = packageManager(rootFiles);
    return DEFAULT_SCRIPTS.filter(name => scripts.has(name)).map(name => ({
        label: `${manager} run ${name}`,
        argv: [manager, 'run', name],
    }));
};
export const summarizeFailures = (runs, lines) => runs
    .filter(run => run.exitCode !== 0)
    .map(run => {
    const tail = run.output.trimEnd().split('\n').slice(-lines).join('\n');
    return `✗ ${run.label} (exit ${run.exitCode})\n${tail}`;
})
    .join('\n\n');
export const isTestCommand = (label) => /\b(test|tests|vitest|jest|mocha|ava|playwright|cypress|pytest|go test|cargo test)\b/.test(label);
// Test runners that default to watch mode run once when CI is set.
export const CHECK_ENV = { CI: 'true' };
// Untracked files that belong elsewhere: Claude Code's subagent worktrees live inside the repo.
export const untrackedPaths = (lsFilesZ) => lsFilesZ
    .split('\0')
    .filter(path => path !== '' && !path.startsWith('.claude/worktrees/'))
    .slice(0, 2000);
// Not cryptographic: two FNV-1a lanes, enough to tell whether the working tree changed.
export const hashText = (text) => {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ text.length;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193) >>> 0;
        b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
};
export const composeFingerprint = (tree, diff, untracked, blobs) => hashText([tree, diff, untracked.join('\0'), blobs].join('\n\0\n'));
