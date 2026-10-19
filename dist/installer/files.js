import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
// Every write goes through a plan first, so --dry-run shows exactly what install or uninstall would touch.
export class Plan {
    changes = [];
    notes = [];
    write(path, content, isOwned = false) {
        const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        if (current !== content)
            this.changes.push({ path, action: 'write', content, isOwned });
    }
    remove(path, isOwned = false) {
        if (existsSync(path))
            this.changes.push({ path, action: 'remove', isOwned });
    }
    note(text) {
        this.notes.push(text);
    }
    // `backupPath` moves backups out of the way, for example out of a repo's working tree.
    apply(stamp, backupPath = path => `${path}.claude-mods-backup-${stamp}`) {
        for (const change of this.changes) {
            if (!change.isOwned && existsSync(change.path) && statSync(change.path).isFile()) {
                const backup = backupPath(change.path);
                mkdirSync(dirname(backup), { recursive: true });
                copyFileSync(change.path, backup);
            }
            if (change.action === 'remove') {
                rmSync(change.path, { recursive: true, force: true });
                continue;
            }
            mkdirSync(dirname(change.path), { recursive: true });
            writeFileSync(change.path, change.content ?? '');
        }
    }
}
export const readJsonObject = (path) => {
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : 'invalid';
    }
    catch {
        return 'invalid';
    }
};
export const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
export const BLOCK_START = '<!-- claude-mods:start (managed by npx claude-mods; edits here are replaced on update) -->';
export const BLOCK_END = '<!-- claude-mods:end -->';
const BLOCK_PATTERN = /\n?<!-- claude-mods:start[^\n]*-->[\s\S]*?<!-- claude-mods:end -->\n?/;
export const withBlock = (text, block) => {
    const without = text.replace(BLOCK_PATTERN, '\n').replace(/\n{3,}$/, '\n\n');
    if (block === undefined)
        return without.trim() === '' ? '' : `${without.trimEnd()}\n`;
    return `${without.trimEnd()}${without.trim() === '' ? '' : '\n\n'}${BLOCK_START}\n${block.trim()}\n${BLOCK_END}\n`;
};
