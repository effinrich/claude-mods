// Generated from core/spec.ts by scripts/sync-core.mjs. Edit core/spec.ts, then run the script.
export type Spec = {
  scope: readonly string[]
  forbid: readonly string[]
  checks: readonly string[]
  body: string
}

export const SPEC_PATH = '.claude/spec.md'

const LIST_KEYS = ['scope', 'forbid', 'checks'] as const
type ListKey = (typeof LIST_KEYS)[number]

const isListKey = (key: string): key is ListKey => (LIST_KEYS as readonly string[]).includes(key)

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2')

const inlineList = (value: string): string[] =>
  value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .filter(item => item !== '')

// A small frontmatter reader: `key: [a, b]`, `key: a`, or `key:` followed by `- item` lines.
export const parseSpec = (text: string): Spec => {
  const lists: Record<ListKey, string[]> = { scope: [], forbid: [], checks: [] }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return { ...lists, body: text.trim() }

  let current: ListKey | undefined
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item !== null && current !== undefined) {
      lists[current].push(unquote(item[1] ?? ''))
      continue
    }
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (pair === null) continue
    const key = pair[1] ?? ''
    current = isListKey(key) ? key : undefined
    const value = (pair[2] ?? '').trim()
    if (current !== undefined && value !== '') lists[current].push(...inlineList(value))
  }
  return { ...lists, body: (match[2] ?? '').trim() }
}

const escapeRegExp = (text: string): string => text.replace(/[.+^${}()|[\]\\]/g, '\\$&')

export const globToRegExp = (glob: string): RegExp => {
  const normalized = glob.replace(/^\.\//, '').replace(/\/$/, '/**')
  let source = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i] ?? ''
    if (char === '*' && normalized[i + 1] === '*') {
      const isSegment = normalized[i + 2] === '/'
      source += isSegment ? '(?:.*/)?' : '.*'
      i += isSegment ? 2 : 1
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

export const matchesAny = (path: string, globs: readonly string[]): boolean =>
  globs.some(glob => globToRegExp(glob).test(path))

export type ScopeVerdict = { isAllowed: true } | { isAllowed: false; reason: string }

export const judgeScope = (relativePath: string, spec: Spec | undefined): ScopeVerdict => {
  if (spec === undefined) return { isAllowed: true }
  if (relativePath === SPEC_PATH) return { isAllowed: true }
  if (matchesAny(relativePath, spec.forbid)) {
    return { isAllowed: false, reason: `${relativePath} is forbidden by ${SPEC_PATH}` }
  }
  if (spec.scope.length > 0 && !matchesAny(relativePath, spec.scope)) {
    return { isAllowed: false, reason: `${relativePath} is outside the scope in ${SPEC_PATH}` }
  }
  return { isAllowed: true }
}

export const draftSpec = (prompt: string): string =>
  [
    '---',
    '# Paths Claude may edit (globs). Empty means anywhere.',
    'scope: []',
    '# Paths Claude must not edit.',
    'forbid: []',
    '# Commands that must pass before finishing or committing. Empty means typecheck + lint from package.json.',
    'checks: []',
    '---',
    '',
    prompt.trim(),
    '',
  ].join('\n')
