// One file that sets skills and gate settings for every surface: Claude Code plugins, the other tools' hooks, the
// installer, `project` and crew agents. A repo's `.claude/claude-mods.json` (committed, the team's) overrides the
// user's `~/.claude-mods/profile.json` key by key.
export const PROFILE_FILE = '.claude/claude-mods.json';
export const USER_PROFILE_FILE = 'profile.json';
export const DEFAULT_TOKEN_BUDGET = 2000;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const skillText = (value) => typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : undefined;
const positive = (value) => (typeof value === 'number' && value >= 0 ? value : undefined);
const flag = (value) => (typeof value === 'boolean' ? value : undefined);
const backgroundMode = (value) => value === 'auto' || value === 'on' || value === 'off' ? value : undefined;
const withoutUndefined = (record) => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
// Unknown keys and wrong types are dropped rather than trusted, so a typo can't switch a gate off by accident.
export const parseProfile = (text) => {
    if (text === undefined)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return {};
    }
    if (!isRecord(parsed))
        return {};
    const roles = isRecord(parsed.roles)
        ? Object.fromEntries(Object.entries(parsed.roles).flatMap(([role, skills]) => (skillText(skills) === undefined ? [] : [[role, skillText(skills) ?? '']])))
        : undefined;
    const guardrails = isRecord(parsed.guardrails)
        ? withoutUndefined({
            stopGate: flag(parsed.guardrails.stopGate),
            writingGate: flag(parsed.guardrails.writingGate),
            researchHoldLines: positive(parsed.guardrails.researchHoldLines),
            checkTimeoutMinutes: positive(parsed.guardrails.checkTimeoutMinutes),
            backgroundChecks: backgroundMode(parsed.guardrails.backgroundChecks),
        })
        : undefined;
    const crew = isRecord(parsed.crew) ? parsed.crew : {};
    return withoutUndefined({
        skills: skillText(parsed.skills),
        roles,
        guardrails,
        crewCap: positive(crew.cap),
        tokenBudget: positive(parsed.tokenBudget),
    });
};
export const mergeProfiles = (user, repo) => ({
    ...user,
    ...repo,
    roles: { ...user.roles, ...repo.roles },
    guardrails: { ...user.guardrails, ...repo.guardrails },
});
