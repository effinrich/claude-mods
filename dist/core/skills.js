export const MAX_SKILL_CHARS = 16_000;
// "ponytail:ponytail full, my-style" → [{ plugin: 'ponytail', skill: 'ponytail', args: 'full' }, { skill: 'my-style' }]
export const parseSkillList = (value) => value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    .map(entry => {
    const [name = '', ...rest] = entry.split(/\s+/);
    const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [undefined, name];
    return { plugin, skill: skill ?? '', args: rest.join(' ') };
})
    .filter(ref => ref.skill !== '');
export const skillLabel = (ref) => `${ref.plugin === undefined ? '' : `${ref.plugin}:`}${ref.skill}${ref.args === '' ? '' : ` ${ref.args}`}`;
const compareVersions = (a, b) => {
    const parts = (version) => version.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
};
export const newestVersion = (versions) => [...versions].sort(compareVersions).at(-1);
// The body a skill expands to, as the engine would hand it over: frontmatter dropped, arguments and roots filled in.
export const renderSkill = (fileText, ref, skillDir, pluginRoot) => {
    const body = fileText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return body
        .replaceAll('$ARGUMENTS', ref.args)
        .replaceAll('${CLAUDE_SKILL_DIR}', skillDir)
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot ?? skillDir);
};
export const clipSkill = (text) => text.length <= MAX_SKILL_CHARS
    ? { text, isClipped: false }
    : { text: `${text.slice(0, MAX_SKILL_CHARS)}\n[... cut at ${MAX_SKILL_CHARS} characters by default-skills]`, isClipped: true };
