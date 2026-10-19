import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDebugOn, payloadLogPath } from "../runner/debug.js";
import { loadConfig, modsHome } from "../runner/state.js";
import { DEFAULT_CONFIG, TOOLS } from "../runner/types.js";
import { ALL_MODS, backupStamp, CLAUDE_EXTRAS, DEFAULT_SKILLS, describePlan, flag, MARKETPLACE, parseList } from "./cli.js";
import { Plan, readJsonObject } from "./files.js";
import { runProject } from "./project.js";
import { instructionLines, planCommands, planDefaultSkills, planInstructions } from "./skills.js";
import { configDir, countOurHooks, hookConfigPath, hookNodePaths, planHooks } from "./tools.js";
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
const loadChoices = () => {
    const stored = readJsonObject(choicesPath());
    return stored === 'invalid' || !Array.isArray(stored.tools) ? undefined : stored;
};
// `debug` is the one setting a user edits by hand, so a reinstall keeps it.
const runtimeConfig = (mods) => ({
    ...DEFAULT_CONFIG,
    debug: (() => {
        const current = readJsonObject(join(modsHome(), 'config.json'));
        return current !== 'invalid' && current.debug === true;
    })(),
    mods: {
        guardrails: mods.includes('guardrails'),
        compactionGuard: mods.includes('compaction-guard'),
        contextAudit: mods.includes('context-audit'),
    },
});
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
    planInstructions(plan, home, tools, isRemoving ? undefined : instructionLines(choices.mods.includes('guardrails'), skills, skill => join(home, '.agents', 'skills', skill, 'SKILL.md')));
    return plan;
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
        plan.apply(backupStamp());
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
        plan.apply(backupStamp());
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
const missingNodePaths = (home) => [...new Set(TOOLS.flatMap(tool => hookNodePaths(home, tool)))].filter(node => !existsSync(node));
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
    for (const node of missingNodePaths(home)) {
        log(`  WARNING: the hooks run Node from ${node}, which no longer exists (a Node upgrade via nvm or similar?).`);
        log('           Run `npx github:effinrich/claude-mods update` to point them at your current Node.');
    }
    const config = loadConfig();
    log(isDebugOn(config)
        ? `  payload capture: on, writing to ${payloadLogPath()}`
        : `  payload capture: off. Turn it on with CLAUDE_MODS_DEBUG=1 or "debug": true in ${join(modsHome(), 'config.json')}; payloads go to ${payloadLogPath()}`);
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
  project     add shared claude-mods files to the current repo (--remove takes them out)

options:
  --tools claude,codex,gemini,cursor,copilot | all   (default: detected)
  --mods guardrails,compaction-guard,context-audit,default-skills | all   (default: all)
  --skills "ponytail:ponytail full, other"           (default-skills list)
  --dry-run   show every file that would change, change nothing

project options:
  --mods ...  also accepts context-meter, cli-passthrough   (default: guardrails,compaction-guard,context-audit,default-skills)
  --skills, --dry-run as above; --remove takes out what project added`;
export const run = (argv, home = homedir(), log = line => console.log(line), cwd = process.cwd()) => {
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
            case 'project':
                return runProject(rest, cwd, log);
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
