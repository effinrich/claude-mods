// Codex `apply_patch` text: "*** Add File:", "*** Update File:" (+ "*** Move to:"), "*** Delete File:" hunks.
// Added lines count as the new text and removed lines as the old, which is what the diff-based rules compare.
export const parsePatch = (patch) => {
    if (!patch.includes('*** Begin Patch'))
        return [];
    const edits = [];
    let current;
    const flush = () => {
        if (current !== undefined)
            edits.push({ path: current.path, newText: current.added.join('\n'), oldText: current.removed.join('\n') });
        current = undefined;
    };
    for (const line of patch.split(/\r?\n/)) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
        if (header !== null) {
            flush();
            current = { path: (header[2] ?? '').trim(), added: [], removed: [] };
            continue;
        }
        const move = /^\*\*\* Move to: (.+)$/.exec(line);
        if (move !== null && current !== undefined) {
            edits.push({ path: current.path, newText: '', oldText: '' });
            current.path = (move[1] ?? '').trim();
            continue;
        }
        if (line.startsWith('*** '))
            continue;
        if (current === undefined)
            continue;
        if (line.startsWith('+'))
            current.added.push(line.slice(1));
        else if (line.startsWith('-'))
            current.removed.push(line.slice(1));
    }
    flush();
    return edits;
};
