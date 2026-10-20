import { globToRegExp, matchesAny } from './spec.ts'

export type Ticket = {
  id: string
  title: string
  role: string
  owns: readonly string[]
  reads: readonly string[]
  blockedBy: readonly string[]
  checks: readonly string[]
  body: string
}

export type CrewPlan = {
  goal: string
  shared: readonly string[]
  checks: readonly string[]
  setup: string | undefined
  cap: number
}

export type TicketStatus = 'queued' | 'running' | 'merged' | 'failed'

// Written at the root of a specialist's worktree by `crew claim`; the edit hooks read it to enforce ownership.
export type Marker = { feature: string; ticket: string; owns: readonly string[]; shared: readonly string[] }

export const MARKER = '.crew-ticket.json'
export const CREW_DIR = '.claude/crew'
export const DEFAULT_CAP = 8
export const ROLES = ['designer', 'frontend', 'backend', 'tester', 'docs', 'reviewer'] as const

// Files every ticket tends to touch. Only the lead edits them, between waves, so parallel tickets never collide there.
export const DEFAULT_SHARED: readonly string[] = ['package.json', '**/package.json', 'tsconfig*.json', '**/tsconfig*.json', '.github/**', MARKER]

const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/, '$2')

const inlineList = (value: string): string[] =>
  value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .filter(item => item !== '')

// `key: value`, `key: [a, b]`, or `key:` followed by `- item` lines. Every value comes back as a list.
export const readFrontmatter = (text: string): { fields: Record<string, string[]>; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return { fields: {}, body: text.trim() }
  const fields: Record<string, string[]> = {}
  let current: string | undefined
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item !== null && current !== undefined) {
      fields[current]?.push(unquote(item[1] ?? ''))
      continue
    }
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (pair === null) continue
    current = pair[1] ?? ''
    const value = (pair[2] ?? '').trim()
    fields[current] = value === '' ? [] : value.startsWith('[') ? inlineList(value) : [unquote(value)]
  }
  return { fields, body: (match[2] ?? '').trim() }
}

export const parseTicket = (id: string, text: string): Ticket => {
  const { fields, body } = readFrontmatter(text)
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]
  return {
    id,
    title: fields.title?.[0] ?? heading ?? id,
    role: fields.role?.[0] ?? '',
    owns: fields.owns ?? [],
    reads: fields.reads ?? [],
    blockedBy: fields.blockedBy ?? [],
    checks: fields.checks ?? [],
    body,
  }
}

export const parsePlan = (text: string): CrewPlan => {
  const { fields, body } = readFrontmatter(text)
  const cap = Number(fields.cap?.[0])
  return {
    goal: fields.goal?.[0] ?? body.split('\n')[0] ?? '',
    shared: [...DEFAULT_SHARED, ...(fields.shared ?? [])],
    checks: fields.checks ?? [],
    setup: fields.setup?.[0],
    cap: Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP,
  }
}

// The literal part of a glob before its first wildcard, cut back to a whole path segment.
const staticPrefix = (glob: string): string => {
  const cut = glob.replace(/^\.\//, '').search(/[*?[{]/)
  const literal = cut === -1 ? glob.replace(/^\.\//, '') : glob.replace(/^\.\//, '').slice(0, cut)
  return cut === -1 ? literal : literal.slice(0, literal.lastIndexOf('/') + 1)
}

// Conservative: two globs may overlap when either's literal prefix contains the other's. False alarms only delay a ticket.
export const mayOverlap = (a: readonly string[], b: readonly string[]): boolean =>
  a.some(left =>
    b.some(right => {
      const [p, q] = [staticPrefix(left), staticPrefix(right)]
      if (!/[*?[{]/.test(left)) return globToRegExp(right).test(p)
      if (!/[*?[{]/.test(right)) return globToRegExp(left).test(q)
      return p.startsWith(q) || q.startsWith(p)
    }),
  )

const ancestors = (id: string, byId: ReadonlyMap<string, Ticket>, seen = new Set<string>()): Set<string> => {
  for (const blocker of byId.get(id)?.blockedBy ?? []) {
    if (seen.has(blocker)) continue
    seen.add(blocker)
    ancestors(blocker, byId, seen)
  }
  return seen
}

const findCycle = (tickets: readonly Ticket[], byId: ReadonlyMap<string, Ticket>): string[] | undefined => {
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): string[] | undefined => {
    if (state.get(id) === 'done') return undefined
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'visiting')
    for (const blocker of byId.get(id)?.blockedBy ?? []) {
      const cycle = visit(blocker, [...path, id])
      if (cycle !== undefined) return cycle
    }
    state.set(id, 'done')
    return undefined
  }
  for (const ticket of tickets) {
    const cycle = visit(ticket.id, [])
    if (cycle !== undefined) return cycle
  }
  return undefined
}

export const validateGraph = (tickets: readonly Ticket[], plan: CrewPlan): { errors: string[]; warnings: string[] } => {
  const errors: string[] = []
  const warnings: string[] = []
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  if (tickets.length === 0) errors.push('no tickets')
  if (byId.size !== tickets.length) errors.push('two tickets share an id')
  for (const ticket of tickets) {
    if (!(ROLES as readonly string[]).includes(ticket.role)) errors.push(`${ticket.id}: role must be one of ${ROLES.join(', ')}`)
    if (ticket.owns.length === 0 && ticket.role !== 'reviewer') errors.push(`${ticket.id}: owns is empty`)
    for (const blocker of ticket.blockedBy) if (!byId.has(blocker)) errors.push(`${ticket.id}: blockedBy ${blocker}, which does not exist`)
    const sharedOwned = ticket.owns.filter(glob => plan.shared.some(shared => !/[*?]/.test(shared) && globToRegExp(glob).test(shared)))
    if (sharedOwned.length > 0) errors.push(`${ticket.id}: owns shared files (${sharedOwned.join(', ')}); only the lead edits those`)
  }
  const cycle = findCycle(tickets, byId)
  if (cycle !== undefined) errors.push(`blockedBy cycle: ${cycle.join(' → ')}`)
  if (cycle === undefined) {
    for (const [i, a] of tickets.entries()) {
      for (const b of tickets.slice(i + 1)) {
        const isOrdered = ancestors(a.id, byId).has(b.id) || ancestors(b.id, byId).has(a.id)
        if (!isOrdered && mayOverlap(a.owns, b.owns)) warnings.push(`${a.id} and ${b.id} may touch the same files, so they will not run at the same time`)
      }
    }
  }
  return { errors, warnings }
}

// Tickets to start now: queued, every blocker merged, no file overlap with anything running, within the cap.
export const frontier = (tickets: readonly Ticket[], statuses: Readonly<Record<string, TicketStatus>>, cap: number): Ticket[] => {
  const running = tickets.filter(ticket => statuses[ticket.id] === 'running')
  const picked: Ticket[] = []
  for (const ticket of tickets) {
    if (running.length + picked.length >= cap) break
    if ((statuses[ticket.id] ?? 'queued') !== 'queued') continue
    if (!ticket.blockedBy.every(blocker => statuses[blocker] === 'merged')) continue
    if ([...running, ...picked].some(other => mayOverlap(ticket.owns, other.owns))) continue
    picked.push(ticket)
  }
  return picked
}

export const outsideOwnership = (relativePaths: readonly string[], marker: Pick<Marker, 'owns' | 'shared'>): { shared: string[]; foreign: string[] } => ({
  shared: relativePaths.filter(path => matchesAny(path, marker.shared)),
  foreign: relativePaths.filter(path => !matchesAny(path, marker.shared) && !matchesAny(path, marker.owns)),
})

export const judgeOwnership = (relativePath: string, marker: Marker): string | undefined => {
  const { shared, foreign } = outsideOwnership([relativePath], marker)
  if (shared.length > 0) return `${relativePath} is shared, so only the crew lead edits it. Put the change you need under "Suggestions:"`
  if (foreign.length > 0) return `${relativePath} is not owned by ticket ${marker.ticket} (owns: ${marker.owns.join(', ')}). Don't edit it; put what it needs under "Suggestions:"`
  return undefined
}

export const parseMarker = (text: string): Marker | undefined => {
  try {
    const value = JSON.parse(text) as Partial<Marker>
    if (typeof value.ticket !== 'string' || !Array.isArray(value.owns) || !Array.isArray(value.shared)) return undefined
    return { feature: String(value.feature ?? ''), ticket: value.ticket, owns: value.owns.map(String), shared: value.shared.map(String) }
  } catch {
    return undefined
  }
}
