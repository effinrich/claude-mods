import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// `isOwned`: a file claude-mods created itself, so it is replaced or removed without a backup.
export type Change = { path: string; action: 'write' | 'remove'; content?: string; isOwned: boolean }

// Every write goes through a plan first, so --dry-run shows exactly what install or uninstall would touch.
export class Plan {
  readonly changes: Change[] = []
  readonly notes: string[] = []

  write(path: string, content: string, isOwned = false): void {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    if (current !== content) this.changes.push({ path, action: 'write', content, isOwned })
  }

  remove(path: string, isOwned = false): void {
    if (existsSync(path)) this.changes.push({ path, action: 'remove', isOwned })
  }

  note(text: string): void {
    this.notes.push(text)
  }

  // `backupPath` moves backups out of the way, for example out of a repo's working tree.
  apply(stamp: string, backupPath: (path: string) => string = path => `${path}.claude-mods-backup-${stamp}`): void {
    for (const change of this.changes) {
      if (!change.isOwned && existsSync(change.path) && statSync(change.path).isFile()) {
        const backup = backupPath(change.path)
        mkdirSync(dirname(backup), { recursive: true })
        copyFileSync(change.path, backup)
      }
      if (change.action === 'remove') {
        rmSync(change.path, { recursive: true, force: true })
        continue
      }
      mkdirSync(dirname(change.path), { recursive: true })
      writeFileSync(change.path, change.content ?? '')
    }
  }
}

export const readJsonObject = (path: string): Record<string, unknown> | 'invalid' => {
  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : 'invalid'
  } catch {
    return 'invalid'
  }
}

export const readText = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

export const BLOCK_START = '<!-- claude-mods:start (managed by npx claude-mods; edits here are replaced on update) -->'
export const BLOCK_END = '<!-- claude-mods:end -->'

const BLOCK_PATTERN = /\n?<!-- claude-mods:start[^\n]*-->[\s\S]*?<!-- claude-mods:end -->\n?/

export const withBlock = (text: string, block: string | undefined): string => {
  const without = text.replace(BLOCK_PATTERN, '\n').replace(/\n{3,}$/, '\n\n')
  if (block === undefined) return without.trim() === '' ? '' : `${without.trimEnd()}\n`
  return `${without.trimEnd()}${without.trim() === '' ? '' : '\n\n'}${BLOCK_START}\n${block.trim()}\n${BLOCK_END}\n`
}
