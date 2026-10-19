export type ParsedCommand = { argv: readonly string[]; needsReload: boolean }

const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  plugin: new Set([
    'install', 'i', 'uninstall', 'remove', 'enable', 'disable', 'update', 'list',
    'details', 'validate', 'configure', 'marketplace',
  ]),
  mcp: new Set(['add', 'add-json', 'remove', 'list', 'get']),
}

const RELOADING: ReadonlySet<string> = new Set(['install', 'i', 'uninstall', 'remove', 'enable', 'disable', 'update', 'marketplace'])

// Anything a shell would interpret is refused: the argv is run directly, never through a shell.
const SHELL_SYNTAX = /[;&|`$<>\\]/

const tokenize = (text: string): string[] | undefined => {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let consumed = 0
  for (const match of text.matchAll(pattern)) {
    if (text.slice(consumed, match.index).trim() !== '') return undefined
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
    consumed = (match.index ?? 0) + match[0].length
  }
  return text.slice(consumed).trim() === '' ? tokens : undefined
}

export const parseCliPrompt = (text: string): ParsedCommand | undefined => {
  const trimmed = text.trim()
  if (!/^claude\s+(plugins?|mcp)\s/.test(trimmed) || SHELL_SYNTAX.test(trimmed)) return undefined

  const tokens = tokenize(trimmed)
  if (tokens === undefined || tokens.length < 3) return undefined
  const [, rawGroup, subcommand] = tokens
  const group = rawGroup === 'plugins' ? 'plugin' : rawGroup
  if (group === undefined || subcommand === undefined || !ALLOWED[group]?.has(subcommand)) return undefined

  return {
    argv: ['claude', group, ...tokens.slice(2)],
    needsReload: group === 'mcp' ? subcommand !== 'list' && subcommand !== 'get' : RELOADING.has(subcommand),
  }
}

// Commands joined by && or on separate lines run in order; one part that is not such a command refuses the prompt.
export const parseCliPrompts = (text: string): readonly ParsedCommand[] | undefined => {
  const parts = text
    .trim()
    .split(/\s*&&\s*|\s*\n\s*/)
    .filter(part => part !== '')
  const parsed = parts.map(parseCliPrompt)
  return parsed.length > 0 && parsed.every((command): command is ParsedCommand => command !== undefined)
    ? (parsed as ParsedCommand[])
    : undefined
}
