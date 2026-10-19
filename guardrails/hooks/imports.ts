// Generated from core/imports.ts by scripts/sync-core.mjs. Edit core/imports.ts, then run the script.
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/

const BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'test', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

const LOCAL_PREFIXES = ['.', '/', '#', '~', '@/', 'virtual:', 'node:', 'bun:', 'data:', 'http:', 'https:', 'npm:', 'jsr:']

// Value imports only: `import type` and `export type` never reach the runtime.
const IMPORT_PATTERNS = [
  /\bimport\s+(?!type\b)(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?!type\b)[\w*{}\s,$]+\s+from\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]

export const isSourceFile = (path: string): boolean => SOURCE_FILE.test(path)

export const packageName = (specifier: string): string | undefined => {
  if (LOCAL_PREFIXES.some(prefix => specifier.startsWith(prefix))) return undefined
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  if (name === undefined || name === '' || BUILTINS.has(name)) return undefined
  return name
}

export const importedPackages = (code: string): string[] => {
  const names = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const name = packageName(match[1] ?? '')
      if (name !== undefined) names.add(name)
    }
  }
  return [...names]
}

// Imports the edit adds: those in the new text that the replaced text did not already have.
export const addedPackages = (newCode: string, oldCode: string): string[] => {
  const before = new Set(importedPackages(oldCode))
  return importedPackages(newCode).filter(name => !before.has(name))
}

export const declaredDependencies = (packageJson: string): Set<string> => {
  const names = new Set<string>()
  try {
    const parsed: unknown = JSON.parse(packageJson)
    if (typeof parsed !== 'object' || parsed === null) return names
    const record = parsed as Record<string, unknown>
    if (typeof record.name === 'string') names.add(record.name)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = record[field]
      if (typeof deps === 'object' && deps !== null) for (const name of Object.keys(deps)) names.add(name)
    }
  } catch {
    return names
  }
  return names
}

const stripJsonComments = (text: string): string =>
  text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, quoted: string | undefined) => quoted ?? '')

// tsconfig `paths` keys (`@app/*` → `@app`) count as local aliases, not packages.
export const pathAliases = (tsconfig: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(tsconfig).replace(/,\s*([}\]])/g, '$1'))
    const paths = (parsed as { compilerOptions?: { paths?: Record<string, unknown> } }).compilerOptions?.paths
    return paths === undefined ? [] : Object.keys(paths).map(key => key.replace(/\/\*$/, '').replace(/\*$/, ''))
  } catch {
    return []
  }
}

export const parentDirs = (filePath: string): string[] => {
  const dirs: string[] = []
  let dir = filePath.replace(/[\\/][^\\/]*$/, '')
  while (dir !== '' && !dirs.includes(dir)) {
    dirs.push(dir)
    const parent = dir.replace(/[\\/][^\\/]*$/, '')
    if (parent === dir) break
    dir = parent
  }
  if (filePath.startsWith('/') && !dirs.includes('/')) dirs.push('/')
  return dirs
}

// Frameworks almost every file imports; holding each new component for `react` would only be noise.
const UBIQUITOUS: ReadonlySet<string> = new Set(['react', 'react-dom', 'preact', 'vue', 'svelte', 'solid-js', 'next', '@angular/core'])

// A scoped package also counts by its scope (`@tldraw/editor` → "tldraw"), which is how people search for it.
const searchTerms = (name: string): string[] => {
  const scope = name.startsWith('@') ? name.split('/')[0]?.slice(1) : undefined
  return [name, ...(scope !== undefined && scope.length >= 3 ? [scope] : [])]
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const isResearched = (name: string, seen: readonly string[]): boolean =>
  searchTerms(name).some(term => {
    const pattern = new RegExp(`(^|[^\\w-])${escapeRegExp(term)}($|[^\\w-])`, 'i')
    return seen.some(text => pattern.test(text))
  })

// Packages a new file builds on that the session has not looked up yet (docs, source, examples, a search).
export const unresearchedPackages = (code: string, seen: readonly string[], allowed: ReadonlySet<string>): string[] =>
  importedPackages(code).filter(name => !UBIQUITOUS.has(name) && !allowed.has(name) && !isResearched(name, seen))
