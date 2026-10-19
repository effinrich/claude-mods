export const ALL_MODS = ['guardrails', 'compaction-guard', 'context-audit', 'default-skills'];
export const CLAUDE_EXTRAS = ['context-meter', 'cli-passthrough'];
export const DEFAULT_SKILLS = 'ponytail:ponytail full, feature-based-architecture';
export const MARKETPLACE = 'effinrich/claude-mods';
export const flag = (args, name) => {
    const index = args.indexOf(`--${name}`);
    if (index !== -1)
        return args[index + 1];
    return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
};
export const parseList = (value, allowed) => {
    if (value === undefined)
        return undefined;
    if (value === 'all')
        return [...allowed];
    const items = value.split(',').map(item => item.trim()).filter(item => item !== '');
    const unknown = items.filter(item => !allowed.includes(item));
    if (unknown.length > 0)
        throw new Error(`unknown: ${unknown.join(', ')} (choose from ${allowed.join(', ')})`);
    return items;
};
export const describePlan = (plan, log, show = path => path) => {
    for (const change of plan.changes)
        log(`  ${change.action === 'remove' ? 'remove' : 'write '} ${show(change.path)}`);
    for (const note of plan.notes)
        log(`  note: ${note}`);
};
export const backupStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
