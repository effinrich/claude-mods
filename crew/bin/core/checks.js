const DEFAULT_SCRIPTS = ['typecheck', 'lint'];
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
const scriptNames = (packageJson) => {
    if (packageJson === undefined)
        return new Set();
    try {
        const scripts = JSON.parse(packageJson).scripts;
        return new Set(scripts === undefined ? [] : Object.keys(scripts));
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
