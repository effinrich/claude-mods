import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { run } from "../main.js";
let base = '';
let repo = '';
let lines = [];
const put = (path, text) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
};
const read = (path) => readFileSync(join(repo, path), 'utf8');
const json = (path) => JSON.parse(read(path));
const project = (...args) => run(['project', ...args], join(base, 'home'), line => lines.push(line), join(repo, 'src'));
const USER_SETTINGS = `${JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] }, enabledPlugins: { 'other@market': true } }, null, 2)}\n`;
beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'claude-mods-project-'));
    repo = join(base, 'repo');
    process.env.CLAUDE_MODS_HOME = join(base, 'home', '.claude-mods');
    lines = [];
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    put('AGENTS.md', '# Team rules\nUse pnpm.\n');
    put('.claude/settings.json', USER_SETTINGS);
});
test('writes the cursor rule, AGENTS.md block and settings from the git root, idempotently', () => {
    assert.equal(project(), 0);
    const first = [read('.cursor/rules/claude-mods.mdc'), read('AGENTS.md'), read('.claude/settings.json')];
    assert.equal(project(), 0);
    assert.deepEqual([read('.cursor/rules/claude-mods.mdc'), read('AGENTS.md'), read('.claude/settings.json')], first);
    assert.ok(lines.includes('  nothing to change'));
    const rule = read('.cursor/rules/claude-mods.mdc');
    assert.match(rule, /^---\ndescription: .+\nglobs:\nalwaysApply: true\n---\n/);
    assert.match(rule, /Follow `\.claude\/spec\.md` exactly/);
    assert.match(rule, /read ~\/\.agents\/skills\/ponytail\/SKILL\.md and follow it; if that file does not exist, skip this line/);
    assert.match(rule, /feature-based-architecture/);
    const agents = read('AGENTS.md');
    assert.match(agents, /^# Team rules\nUse pnpm\.\n\n<!-- claude-mods:start/);
    assert.equal(agents.match(/claude-mods:start/g)?.length, 1);
    assert.ok(agents.includes(rule.split('-->\n')[1]?.trim() ?? 'missing'));
    const settings = json('.claude/settings.json');
    assert.deepEqual(settings.permissions, { allow: ['Bash(pnpm test)'] });
    assert.deepEqual(settings.extraKnownMarketplaces, { 'claude-mods': { source: { source: 'github', repo: 'effinrich/claude-mods' } } });
    assert.deepEqual(settings.enabledPlugins, {
        'other@market': true,
        'guardrails@claude-mods': true,
        'compaction-guard@claude-mods': true,
        'context-audit@claude-mods': true,
        'default-skills@claude-mods': true,
    });
});
test('--remove restores the original files and deletes the ones it created', () => {
    project('--mods', 'guardrails,context-meter');
    assert.equal(json('.claude/settings.json').enabledPlugins['context-meter@claude-mods'], true);
    assert.equal(project('--remove'), 0);
    assert.equal(read('AGENTS.md'), '# Team rules\nUse pnpm.\n');
    assert.equal(read('.claude/settings.json'), USER_SETTINGS);
    assert.equal(existsSync(join(repo, '.cursor')), false);
    assert.equal(readdirSync(repo).some(name => name.includes('backup')), false);
    const backups = join(base, 'home', '.claude-mods', 'backups');
    assert.ok(existsSync(backups));
});
test('--remove takes out files it created from nothing', () => {
    rmSync(join(repo, 'AGENTS.md'));
    rmSync(join(repo, '.claude'), { recursive: true });
    project();
    assert.ok(existsSync(join(repo, 'AGENTS.md')));
    project('--remove');
    assert.deepEqual(readdirSync(repo).sort(), ['.git', 'src']);
});
test('keeps a plugin the user turned off and drops mods no longer chosen', () => {
    put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'guardrails@claude-mods': false } }));
    project();
    project('--mods', 'guardrails,context-audit');
    const enabled = json('.claude/settings.json').enabledPlugins;
    assert.deepEqual(enabled, { 'guardrails@claude-mods': false, 'context-audit@claude-mods': true });
});
test('--dry-run writes nothing and lists the files', () => {
    assert.equal(project('--dry-run'), 0);
    assert.equal(read('AGENTS.md'), '# Team rules\nUse pnpm.\n');
    assert.equal(read('.claude/settings.json'), USER_SETTINGS);
    assert.equal(existsSync(join(repo, '.cursor')), false);
    assert.ok(lines.some(line => line.endsWith(join('.cursor', 'rules', 'claude-mods.mdc'))));
    project();
    const before = read('AGENTS.md');
    assert.equal(project('--remove', '--dry-run'), 0);
    assert.equal(read('AGENTS.md'), before);
});
test('leaves a cursor rule it did not write alone', () => {
    put('.cursor/rules/claude-mods.mdc', '---\nalwaysApply: true\n---\nmine');
    project();
    assert.equal(read('.cursor/rules/claude-mods.mdc'), '---\nalwaysApply: true\n---\nmine');
    assert.ok(lines.some(line => line.includes('not managed by claude-mods')));
});
test('refuses to run outside a git repository', () => {
    const outside = mkdtempSync(join(tmpdir(), 'claude-mods-nogit-'));
    assert.equal(run(['project'], join(base, 'home'), line => lines.push(line), outside), 1);
    assert.ok(lines.some(line => line.includes('not inside a git repository')));
});
