import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseSkillList } from "../core/skills.js";
import { modsHome } from "../runner/state.js";
import { ALL_MODS, backupStamp, CLAUDE_EXTRAS, DEFAULT_SKILLS, describePlan, flag, MARKETPLACE, parseList } from "./cli.js";
import { Plan, readJsonObject, readText, withBlock } from "./files.js";
import { parseProfile, PROFILE_FILE } from "../core/profile.js";
import { instructionLines, MANAGED, planManagedFile } from "./skills.js";
const PLUGINS = [...ALL_MODS, ...CLAUDE_EXTRAS];
const MARKETPLACE_NAME = 'claude-mods';
const PLUGIN_SUFFIX = `@${MARKETPLACE_NAME}`;
export const RULE_PATH = join('.cursor', 'rules', 'claude-mods.mdc');
export const SETTINGS_PATH = join('.claude', 'settings.json');
export const gitRoot = (cwd) => {
    let dir = resolve(cwd);
    for (;;) {
        if (existsSync(join(dir, '.git')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
};
// https://cursor.com/docs/context/rules: with alwaysApply true, globs and description are ignored but harmless.
const cursorRule = (body) => `---
description: claude-mods guardrails and always-on skills for this repo
globs:
alwaysApply: true
---
${MANAGED}
${body}
`;
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
const setOrDrop = (target, key, value) => {
    if (Object.keys(value).length === 0)
        delete target[key];
    else
        target[key] = value;
};
const planAgents = (plan, path, block) => {
    const current = readText(path);
    const next = withBlock(current ?? '', block);
    if (next !== '')
        return plan.write(path, next);
    if (current !== undefined && current.trim() !== '')
        plan.remove(path);
};
// Only entries claude-mods owns are touched: its marketplace and `<mod>@claude-mods` set to true. A plugin the
// user turned off (false) stays off.
const planSettings = (plan, path, plugins) => {
    const existing = readJsonObject(path);
    if (existing === 'invalid') {
        plan.note(`${path} is not plain JSON, so it was left alone. Add the claude-mods marketplace and plugins by hand.`);
        return;
    }
    const next = { ...existing };
    const marketplaces = record(existing.extraKnownMarketplaces);
    const enabled = record(existing.enabledPlugins);
    for (const [key, value] of Object.entries(enabled)) {
        if (key.endsWith(PLUGIN_SUFFIX) && value === true && !plugins?.includes(key.slice(0, -PLUGIN_SUFFIX.length))) {
            delete enabled[key];
        }
    }
    if (plugins === undefined)
        delete marketplaces[MARKETPLACE_NAME];
    else {
        marketplaces[MARKETPLACE_NAME] = { source: { source: 'github', repo: MARKETPLACE } };
        for (const plugin of plugins)
            enabled[`${plugin}${PLUGIN_SUFFIX}`] ??= true;
    }
    setOrDrop(next, 'extraKnownMarketplaces', marketplaces);
    setOrDrop(next, 'enabledPlugins', enabled);
    if (Object.keys(next).length > 0)
        return plan.write(path, `${JSON.stringify(next, null, 2)}\n`);
    if (existsSync(path))
        plan.remove(path);
};
const PROFILE_MARKER = 'claude-mods project';
// The team profile: written when the repo has none, removed only if claude-mods wrote it.
const planProfile = (plan, path, skills, isRemoving) => {
    const current = readText(path);
    const isOurs = current !== undefined && current.includes(`"$managedBy": "${PROFILE_MARKER}"`);
    if (current !== undefined && !isOurs) {
        if (!isRemoving)
            plan.note(`${path} exists and is not managed by claude-mods, so it was left alone (its skills are used).`);
        return;
    }
    if (isRemoving)
        return isOurs ? plan.remove(path, true) : undefined;
    plan.write(path, `${JSON.stringify({ $managedBy: PROFILE_MARKER, skills, guardrails: {}, roles: {} }, null, 2)}\n`, true);
};
const pruneEmptyDirs = (root, dirs) => {
    for (const dir of dirs.map(name => join(root, name))) {
        if (existsSync(dir) && readdirSync(dir).length === 0)
            rmdirSync(dir);
    }
};
export const planProject = (root, plugins, skillFlag, isRemoving) => {
    const skillList = skillFlag ?? parseProfile(readText(join(root, PROFILE_FILE))).skills ?? DEFAULT_SKILLS;
    const skills = plugins.includes('default-skills') ? parseSkillList(skillList) : [];
    // `~` rather than this machine's home: the files are committed and read on every teammate's machine.
    const lines = isRemoving ? [] : instructionLines(plugins.includes('guardrails'), skills, skill => `~/.agents/skills/${skill}/SKILL.md`, true);
    const block = lines.length === 0 ? undefined : lines.join('\n');
    const plan = new Plan();
    planManagedFile(plan, join(root, RULE_PATH), block === undefined ? undefined : cursorRule(block));
    planAgents(plan, join(root, 'AGENTS.md'), block);
    planSettings(plan, join(root, SETTINGS_PATH), isRemoving ? undefined : plugins);
    planProfile(plan, join(root, PROFILE_FILE), skillList, isRemoving);
    return plan;
};
const backupDir = (root, stamp) => {
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 6);
    return join(modsHome(), 'backups', `${basename(root) || 'project'}-${hash}`, stamp);
};
export const runProject = (args, cwd, log) => {
    const root = gitRoot(cwd);
    if (root === undefined) {
        log('claude-mods project: not inside a git repository. Run it from the repo you want to set up.');
        return 1;
    }
    const isRemoving = args.includes('--remove');
    const isDryRun = args.includes('--dry-run');
    const plugins = parseList(flag(args, 'mods'), PLUGINS) ?? [...ALL_MODS];
    const plan = planProject(root, plugins, flag(args, 'skills'), isRemoving);
    log(`${isDryRun ? '[dry run] ' : ''}claude-mods project ${isRemoving ? 'remove' : plugins.join(', ')} → ${root}`);
    describePlan(plan, log, path => relative(root, path));
    if (plan.changes.length === 0)
        log('  nothing to change');
    if (isDryRun || plan.changes.length === 0)
        return 0;
    const stamp = backupStamp();
    const backups = backupDir(root, stamp);
    plan.apply(stamp, path => join(backups, relative(root, path)));
    if (isRemoving)
        pruneEmptyDirs(root, [join('.cursor', 'rules'), '.cursor', '.claude']);
    if (existsSync(backups))
        log(`  backups of changed files: ${backups}`);
    log(isRemoving ? 'Removed. Commit the result.' : `Commit ${RULE_PATH}, AGENTS.md, ${SETTINGS_PATH} and ${PROFILE_FILE}. Each teammate still runs the global install once.`);
    return 0;
};
