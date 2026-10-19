import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modsHome } from "../runner/state.js";
import { DEFAULT_CONFIG, TOOLS } from "../runner/types.js";
import { Plan, readJsonObject } from "./files.js";
import { planCommands, planDefaultSkills, planInstructions } from "./skills.js";
import { configDir, countOurHooks, hookConfigPath, planHooks } from "./tools.js";
const ALL_MODS = ['guardrails', 'compaction-guard', 'context-audit', 'default-skills'];
const CLAUDE_EXTRAS = ['context-meter', 'cli-passthrough'];
const DEFAULT_SKILLS = 'ponytail:ponytail full, feature-based-architecture';
const MARKETPLACE = 'effinrich/claude-mods';
const BINARIES = {
    claude: ['claude'],
    codex: ['codex'],
    gemini: ['gemini'],
    cursor: ['cursor-agent', 'cursor'],
    copilot: ['copilot'],
};
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
const runtimeDir = () => join(modsHome(), 'runtime', version);
const runtimeMain = () => join(runtimeDir(), 'dist', 'runner', 'main.js');
const choicesPath = () => join(modsHome(), 'install.json');
const onPath = (name) => (process.env.PATH ?? '').split(delimiter).some(dir => ['', '.cmd', '.exe'].some(suffix => dir !== '' && existsSync(join(dir, `${name}${suffix}`))));
export const detectTools = (home) => ['claude', ...TOOLS].filter(tool => BINARIES[tool].some(onPath) || (tool !== 'claude' && existsSync(configDir(home, tool))));
const flag = (args, name) => {
    const index = args.indexOf(`--${name}`);
    if (index !== -1)
        return args[index + 1];
    return args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
};
const parseList = (value, allowed) => {
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
const loadChoices = () => {
    const stored = readJsonObject(choicesPath());
    return stored === 'invalid' || !Array.isArray(stored.tools) ? undefined : stored;
};
const runtimeConfig = (mods) => ({
    ...DEFAULT_CONFIG,
    mods: {
        guardrails: mods.includes('guardrails'),
        compactionGuard: mods.includes('compaction-guard'),
        contextAudit: mods.includes('context-audit'),
    },
});
const instructionLines = (mods, skills, home) => [
    ...(mods.includes('guardrails')
        ? [
            '- Follow `.claude/spec.md` exactly when it exists; hooks block edits outside its scope.',
            '- Put out-of-scope ideas under "Suggestions:" (at most 3 bullets) instead of doing them. Be terse.',
            '- Never invent APIs, packages, flags or file contents: read, search, or say you do not know.',
        ]
        : []),
    ...skills.map(ref => `- Always on: the \`${ref.skill}\` skill${ref.args ? ` with arguments \`${ref.args}\`` : ''}. At the start of each session, read ${join(home, '.agents', 'skills', ref.skill, 'SKILL.md')} and follow it.`),
];
const runClaude = (args, isDryRun, log) => {
    log(`  $ claude ${args.join(' ')}`);
    if (isDryRun)
        return;
    const ran = spawnSync('claude', args, { encoding: 'utf8', shell: process.platform === 'win32' });
    if (ran.status !== 0)
        log(`    ${(ran.stderr || ran.stdout || 'failed').trim().split('\n').slice(-2).join(' ')}`);
};
const planFor = (home, choices, isRemoving) => {
    const plan = new Plan();
    const tools = choices.tools.filter((tool) => tool !== 'claude');
    const main = isRemoving ? undefined : runtimeMain();
    for (const tool of tools)
        planHooks(plan, home, tool, main);
    planCommands(plan, home, tools, choices.mods.includes('guardrails') ? main : undefined);
    const skills = choices.mods.includes('default-skills') ? planDefaultSkills(plan, home, tools, choices.skills, isRemoving) : [];
    planInstructions(plan, home, tools, isRemoving ? undefined : instructionLines(choices.mods, skills, home));
    return plan;
};
const describePlan = (plan, log) => {
    for (const change of plan.changes)
        log(`  ${change.action === 'remove' ? 'remove' : 'write '} ${change.path}`);
    for (const note of plan.notes)
        log(`  note: ${note}`);
};
const install = (args, home, log, isUpdate) => {
    const stored = loadChoices();
    const detected = detectTools(home);
    const choices = {
        tools: parseList(flag(args, 'tools'), ['claude', ...TOOLS]) ?? (isUpdate ? stored?.tools : undefined) ?? detected,
        mods: parseList(flag(args, 'mods'), ALL_MODS) ?? (isUpdate ? stored?.mods : undefined) ?? [...ALL_MODS],
        skills: flag(args, 'skills') ?? (isUpdate ? stored?.skills : undefined) ?? DEFAULT_SKILLS,
    };
    const isDryRun = args.includes('--dry-run');
    if (choices.tools.length === 0) {
        log('No supported tools found (claude, codex, gemini, cursor, copilot). Pass --tools to choose.');
        return 1;
    }
    log(`${isDryRun ? '[dry run] ' : ''}claude-mods ${version}: ${choices.mods.join(', ')} → ${choices.tools.join(', ')}`);
    if (!isDryRun) {
        rmSync(runtimeDir(), { recursive: true, force: true });
        mkdirSync(runtimeDir(), { recursive: true });
        cpSync(join(packageRoot, 'dist'), join(runtimeDir(), 'dist'), { recursive: true, filter: source => !/[\\/]tests([\\/]|$)/.test(source) });
        writeFileSync(join(runtimeDir(), 'package.json'), `${JSON.stringify({ type: 'module', version })}\n`);
        writeFileSync(join(modsHome(), 'config.json'), `${JSON.stringify(runtimeConfig(choices.mods), null, 2)}\n`);
        writeFileSync(choicesPath(), `${JSON.stringify(choices, null, 2)}\n`);
    }
    log(`  runtime → ${runtimeDir()}`);
    const plan = planFor(home, choices, false);
    describePlan(plan, log);
    if (!isDryRun)
        plan.apply(new Date().toISOString().replace(/[:.]/g, '-'));
    if (choices.tools.includes('claude')) {
        log('Claude Code (marketplace plugins):');
        runClaude(['plugin', 'marketplace', isUpdate ? 'update' : 'add', isUpdate ? 'claude-mods' : MARKETPLACE], isDryRun, log);
        for (const mod of [...choices.mods, ...CLAUDE_EXTRAS]) {
            runClaude(['plugin', isUpdate ? 'update' : 'install', `${mod}@claude-mods`], isDryRun, log);
        }
    }
    log('Next:');
    if (choices.tools.includes('codex'))
        log('  codex: open Codex and approve the new hooks in /hooks (they do not run until you do).');
    if (choices.tools.includes('gemini'))
        log('  gemini: Gemini CLI shows the new hooks once; confirm them (/hooks panel lists them).');
    if (choices.tools.includes('cursor'))
        log('  cursor: restart Cursor so it reloads ~/.cursor/hooks.json.');
    if (choices.tools.includes('copilot'))
        log('  copilot: start a new Copilot CLI session to load ~/.copilot/hooks/claude-mods.json.');
    log('  Run `npx github:effinrich/claude-mods doctor` to check everything is wired.');
    return 0;
};
const uninstall = (args, home, log) => {
    const choices = loadChoices() ?? { tools: detectTools(home), mods: [...ALL_MODS], skills: DEFAULT_SKILLS };
    const isDryRun = args.includes('--dry-run');
    log(`${isDryRun ? '[dry run] ' : ''}Removing claude-mods from ${choices.tools.join(', ')}`);
    const plan = planFor(home, choices, true);
    describePlan(plan, log);
    if (!isDryRun) {
        plan.apply(new Date().toISOString().replace(/[:.]/g, '-'));
        rmSync(join(modsHome(), 'runtime'), { recursive: true, force: true });
        rmSync(choicesPath(), { force: true });
        rmSync(join(modsHome(), 'config.json'), { force: true });
    }
    if (choices.tools.includes('claude')) {
        log('Claude Code:');
        for (const mod of [...choices.mods, ...CLAUDE_EXTRAS])
            runClaude(['plugin', 'uninstall', `${mod}@claude-mods`], isDryRun, log);
    }
    log(`Kept: handoffs and session state in ${modsHome()} (delete the folder to remove them). Backups of edited files end in .claude-mods-backup-<time>.`);
    return 0;
};
const doctor = (home, log) => {
    const choices = loadChoices();
    log(`claude-mods ${version} · node ${process.version}`);
    log(`  install record: ${choices === undefined ? 'none (not installed yet)' : `${choices.mods.join(', ')} → ${choices.tools.join(', ')}`}`);
    log(`  runtime: ${existsSync(runtimeMain()) ? `ok (${runtimeMain()})` : 'missing: run install or update'}`);
    log(`  detected tools: ${detectTools(home).join(', ') || 'none'}`);
    for (const tool of TOOLS) {
        const count = countOurHooks(home, tool);
        const expected = choices?.tools.includes(tool) ?? false;
        const status = count > 0 ? `${count} hook${count === 1 ? '' : 's'} in ${hookConfigPath(home, tool)}` : expected ? 'MISSING: run update' : 'not installed';
        log(`  ${tool.padEnd(8)} ${status}`);
    }
    const logPath = join(modsHome(), 'hook.log');
    if (existsSync(logPath)) {
        const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-5);
        log('  recent hook errors:');
        for (const line of lines)
            log(`    ${line.slice(0, 200)}`);
    }
    return 0;
};
const USAGE = `usage: npx github:${MARKETPLACE} <command> [options]

commands:
  install     wire the mods into each detected tool (default)
  update      reinstall with your last choices (after pulling a new version)
  uninstall   remove hooks, skills and instruction blocks this installed
  doctor      show what is installed where

options:
  --tools claude,codex,gemini,cursor,copilot | all   (default: detected)
  --mods guardrails,compaction-guard,context-audit,default-skills | all   (default: all)
  --skills "ponytail:ponytail full, other"           (default-skills list)
  --dry-run   show every file that would change, change nothing`;
export const run = (argv, home = homedir(), log = line => console.log(line)) => {
    const [command = 'install', ...rest] = argv;
    try {
        switch (command) {
            case 'install':
                return install(rest, home, log, false);
            case 'update':
                return install(rest, home, log, true);
            case 'uninstall':
                return uninstall(rest, home, log);
            case 'doctor':
                return doctor(home, log);
            default:
                log(USAGE);
                return command === 'help' || command === '--help' ? 0 : 1;
        }
    }
    catch (error) {
        log(`claude-mods: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
};
