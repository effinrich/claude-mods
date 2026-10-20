#!/usr/bin/env node
// Claude Code installs each plugin folder on its own, so each one carries a copy of the core files it uses.
// `node scripts/sync-core.mjs` writes the copies; `--check` fails when any copy differs from core/.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const COPIES = {
  guardrails: ['spec', 'imports', 'rules', 'checks', 'crew', 'profile'],
  'compaction-guard': ['handoff'],
  'context-audit': ['drift'],
  'default-skills': ['skills', 'profile'],
}

const header = name => `// Generated from core/${name}.ts by scripts/sync-core.mjs. Edit core/${name}.ts, then run the script.\n`

const isCheck = process.argv.includes('--check')
const stale = []

for (const [plugin, names] of Object.entries(COPIES)) {
  for (const name of names) {
    const expected = header(name) + readFileSync(join(root, 'core', `${name}.ts`), 'utf8')
    const target = join(root, plugin, 'hooks', `${name}.ts`)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined
    if (current === expected) continue
    if (isCheck) stale.push(`${plugin}/hooks/${name}.ts`)
    else writeFileSync(target, expected)
  }
}

if (stale.length > 0) {
  console.error(`Out of sync with core/: ${stale.join(', ')}. Run: node scripts/sync-core.mjs`)
  process.exit(1)
}
