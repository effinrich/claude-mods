const COMMAND_RULES = [
    { pattern: /--no-verify\b/, reason: 'skips the hooks that guard commits; fix what they report instead' },
    { pattern: /\bgit\s+commit\b[^|;&]*\s-[a-zA-Z]*n[a-zA-Z]*\b/, reason: '`-n` skips the commit hooks; fix what they report instead' },
    {
        pattern: /\bgit\s+push\b[^|;&]*(\s--force(?!-with-lease)\b|\s-[a-zA-Z]*f\b)/,
        reason: 'force-pushing rewrites shared history; use --force-with-lease on your own branch only if the user asks',
    },
    { pattern: /\bgit\s+reset\s+[^|;&]*--hard\b/, reason: 'destroys uncommitted work' },
    { pattern: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, reason: 'discards every uncommitted change' },
    { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: 'deletes untracked files for good' },
    { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|~|\$HOME)(\/?\s|\/?$)/, reason: 'deletes a home or root directory' },
];
export const judgeCommand = (command) => COMMAND_RULES.find(rule => rule.pattern.test(command))?.reason;
export const isGitCommit = (command) => /\bgit\s+commit\b/.test(command);
const WEAKENING = [
    { pattern: /\b(it|test|describe)\.(skip|only)\s*\(/, reason: 'skips or isolates tests' },
    { pattern: /\b(xit|xdescribe|xtest)\s*\(/, reason: 'skips tests' },
    { pattern: /@ts-(ignore|nocheck|expect-error)\b/, reason: 'silences the type checker' },
    { pattern: /eslint-disable/, reason: 'silences the linter' },
    { pattern: /\bas\s+any\b|:\s*any\b(?!\w)|<any>/, reason: 'adds an `any` type', isTypeScriptOnly: true },
];
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock)$/;
export const isLockfile = (path) => LOCKFILES.test(path);
// Only what the edit adds counts, so touching a file that already has a suppression is fine.
export const judgeWeakening = (newCode, oldCode, path) => {
    const isTypeScript = /\.(c|m)?tsx?$/.test(path);
    for (const rule of WEAKENING) {
        if (rule.isTypeScriptOnly === true && !isTypeScript)
            continue;
        const count = (code) => code.split('\n').filter(line => rule.pattern.test(line)).length;
        if (count(newCode) > count(oldCode))
            return rule.reason;
    }
    return undefined;
};
// Commands whose text lands in front of people: commit messages, tags, PR and issue text.
const PROSE_COMMAND = /\bgit\s+(commit|tag)\b|\bgh\s+(pr|issue)\s+(create|edit|comment|review)\b/;
// Few and unambiguous on purpose: each one blocks a commit until the message is reworded.
const SLOP = [
    { pattern: /—/, label: 'an em dash' },
    { pattern: /\bdelv(e|es|ed|ing)\b/i, label: '"delve"' },
    { pattern: /\bseamless(ly)?\b/i, label: '"seamless"' },
    { pattern: /\bleverag(e|es|ed|ing)\b/i, label: '"leverage"' },
    { pattern: /\brobust(ly|ness)?\b/i, label: '"robust"' },
    { pattern: /\bcomprehensive\b/i, label: '"comprehensive"' },
    { pattern: /\bit['’]?s worth noting\b/i, label: '"it\'s worth noting"' },
    { pattern: /\b(a testament to|rich tapestry|game[- ]changer|in today['’]s fast-paced)\b/i, label: 'stock AI phrasing' },
    { pattern: /\bI hope this helps\b/i, label: '"I hope this helps"' },
];
export const judgeProse = (command) => {
    if (!PROSE_COMMAND.test(command))
        return undefined;
    const hits = SLOP.filter(rule => rule.pattern.test(command)).map(rule => rule.label);
    return hits.length === 0 ? undefined : `the message uses ${hits.join(', ')}`;
};
