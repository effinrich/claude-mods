export const SPEC_PATH = '.claude/spec.md';
const LIST_KEYS = ['scope', 'forbid', 'checks'];
const isListKey = (key) => LIST_KEYS.includes(key);
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
const inlineList = (value) => value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .filter(item => item !== '');
// A small frontmatter reader: `key: [a, b]`, `key: a`, or `key:` followed by `- item` lines.
export const parseSpec = (text) => {
    const lists = { scope: [], forbid: [], checks: [] };
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (match === null)
        return { ...lists, body: text.trim() };
    let current;
    for (const line of (match[1] ?? '').split(/\r?\n/)) {
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (item !== null && current !== undefined) {
            lists[current].push(unquote(item[1] ?? ''));
            continue;
        }
        const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
        if (pair === null)
            continue;
        const key = pair[1] ?? '';
        current = isListKey(key) ? key : undefined;
        const value = (pair[2] ?? '').trim();
        if (current !== undefined && value !== '')
            lists[current].push(...inlineList(value));
    }
    return { ...lists, body: (match[2] ?? '').trim() };
};
const escapeRegExp = (text) => text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
export const globToRegExp = (glob) => {
    const normalized = glob.replace(/^\.\//, '').replace(/\/$/, '/**');
    let source = '';
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i] ?? '';
        if (char === '*' && normalized[i + 1] === '*') {
            const isSegment = normalized[i + 2] === '/';
            source += isSegment ? '(?:.*/)?' : '.*';
            i += isSegment ? 2 : 1;
        }
        else if (char === '*')
            source += '[^/]*';
        else if (char === '?')
            source += '[^/]';
        else
            source += escapeRegExp(char);
    }
    return new RegExp(`^${source}$`);
};
export const matchesAny = (path, globs) => globs.some(glob => globToRegExp(glob).test(path));
export const judgeScope = (relativePath, spec) => {
    if (spec === undefined)
        return { isAllowed: true };
    if (relativePath === SPEC_PATH)
        return { isAllowed: true };
    if (matchesAny(relativePath, spec.forbid)) {
        return { isAllowed: false, reason: `${relativePath} is forbidden by ${SPEC_PATH}` };
    }
    if (spec.scope.length > 0 && !matchesAny(relativePath, spec.scope)) {
        return { isAllowed: false, reason: `${relativePath} is outside the scope in ${SPEC_PATH}` };
    }
    return { isAllowed: true };
};
export const draftSpec = (prompt) => [
    '---',
    '# Paths Claude may edit (globs). Empty means anywhere.',
    'scope: []',
    '# Paths Claude must not edit.',
    'forbid: []',
    '# Commands that must pass before finishing or committing. Empty means the typecheck, lint and test scripts from package.json.',
    'checks: []',
    '---',
    '',
    prompt.trim(),
    '',
].join('\n');
