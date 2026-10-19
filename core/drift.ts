export type FileSnapshot = { sha: string; lines: readonly string[] }

export type Snapshot = {
  files: Readonly<Record<string, FileSnapshot>>
  plugins: readonly string[]
  hooksSha: string
}

const SHOWN_LINES = 5
const LINE_WIDTH = 140

// Lines worth a second look in a global instruction file: remote fetches and override phrasing.
const SUSPICIOUS = /(https?:\/\/|\bcurl\b|\bwget\b|\bfetch\b|base64|ignore (all |any )?(previous|prior)|do not tell)/i

export const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const snapshotFile = async (text: string): Promise<FileSnapshot> => ({
  sha: await sha256(text),
  lines: text.split(/\r?\n/),
})

const clip = (line: string): string => (line.length <= LINE_WIDTH ? line : `${line.slice(0, LINE_WIDTH)}…`)

// Each change is one entry; its detail lines follow on the same entry after newlines.
const describeFile = (path: string, before: FileSnapshot | undefined, after: FileSnapshot): string[] => {
  if (before === undefined) return [`new global instruction file: ${path} (${after.lines.length} lines)`]
  if (before.sha === after.sha) return []

  const oldLines = new Set(before.lines)
  const newLines = new Set(after.lines)
  const added = after.lines.filter(line => line.trim() !== '' && !oldLines.has(line))
  const removed = before.lines.filter(line => line.trim() !== '' && !newLines.has(line)).length
  const flagged = added.filter(line => SUSPICIOUS.test(line))

  const summary =
    `${path} changed: +${added.length} / -${removed} lines` + (flagged.length > 0 ? `, ${flagged.length} flagged` : '')
  const details = [...flagged, ...added.filter(line => !SUSPICIOUS.test(line))]
    .slice(0, SHOWN_LINES)
    .map(line => `  ${SUSPICIOUS.test(line) ? '⚠' : '+'} ${clip(line.trim())}`)
  return [[summary, ...details].join('\n')]
}

export const diffSnapshots = (before: Snapshot, after: Snapshot): string[] => {
  const changes = Object.entries(after.files).flatMap(([path, file]) => describeFile(path, before.files[path], file))
  for (const path of Object.keys(before.files)) {
    if (after.files[path] === undefined) changes.push(`global instruction file no longer loaded: ${path}`)
  }

  const added = after.plugins.filter(id => !before.plugins.includes(id))
  const removed = before.plugins.filter(id => !after.plugins.includes(id))
  if (added.length > 0) changes.push(`plugins enabled since last session: ${added.join(', ')}`)
  if (removed.length > 0) changes.push(`plugins disabled since last session: ${removed.join(', ')}`)
  if (before.hooksSha !== after.hooksSha) changes.push('user settings hooks changed')
  return changes
}
