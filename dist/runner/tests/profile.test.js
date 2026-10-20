import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { mergeProfiles, parseProfile } from "../../core/profile.js";
import { decide } from "../engine.js";
import { loadConfig, loadProfile } from "../state.js";
import { DEFAULT_CONFIG } from "../types.js";
let root = '';
let modsHome = '';
beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), 'claude-mods-profile-'));
    root = join(base, 'app');
    modsHome = join(base, 'mods');
    process.env.CLAUDE_MODS_HOME = modsHome;
    process.env.HOME = join(base, 'home');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(modsHome, { recursive: true });
});
test('reads skills as a string or list and drops keys with the wrong type', () => {
    const profile = parseProfile(JSON.stringify({
        skills: ['ponytail:ponytail full', 'plain-writing'],
        roles: { designer: 'frontend-design', backend: 3 },
        guardrails: { writingGate: 'no', researchHoldLines: 0, stopGate: false },
        crew: { cap: 12 },
        tokenBudget: 3000,
    }));
    assert.deepEqual(profile, {
        skills: 'ponytail:ponytail full, plain-writing',
        roles: { designer: 'frontend-design' },
        guardrails: { stopGate: false, researchHoldLines: 0 },
        crewCap: 12,
        tokenBudget: 3000,
    });
    assert.deepEqual(parseProfile('not json'), {});
});
test('the repo profile overrides the user profile key by key', () => {
    const merged = mergeProfiles({ skills: 'a', roles: { designer: 'x' }, guardrails: { writingGate: false, stopGate: true } }, { skills: 'b', roles: { backend: 'y' }, guardrails: { stopGate: false } });
    assert.equal(merged.skills, 'b');
    assert.deepEqual(merged.roles, { designer: 'x', backend: 'y' });
    assert.deepEqual(merged.guardrails, { writingGate: false, stopGate: false });
});
test('the other tools\' hooks apply the profile: a team can turn the writing check off', async () => {
    writeFileSync(join(modsHome, 'profile.json'), JSON.stringify({ skills: 'mine', guardrails: { checkTimeoutMinutes: 2 } }));
    writeFileSync(join(root, '.claude/claude-mods.json'), JSON.stringify({ guardrails: { writingGate: false } }));
    assert.equal(loadProfile(root).skills, 'mine');
    assert.equal(loadConfig(root).writingGate, false);
    assert.equal(loadConfig(root).checkTimeoutMs, 120_000);
    assert.equal(loadConfig().writingGate, true);
    const commit = await decide('codex', { promptContext: true }, DEFAULT_CONFIG, { sessionId: 's', cwd: root, kind: 'shell', command: 'git tag -a v1 -m "A seamless release"' }, new Date());
    assert.equal(commit.kind, 'allow');
});
