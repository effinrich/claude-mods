#!/usr/bin/env node
// The crew plugin is installed on its own, so it carries the compiled crew CLI and the modules it imports.
// Runs after tsc as part of `npm run build`; crew/bin is committed like dist/.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const bin = join(root, 'crew', 'bin')

const seen = new Set()
const collect = file => {
  if (seen.has(file)) return
  seen.add(file)
  for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) collect(join(dirname(file), match[1]))
}
collect(join(dist, 'runner', 'crew.js'))

rmSync(bin, { recursive: true, force: true })
for (const file of [...seen].sort()) {
  const target = join(bin, relative(dist, file))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(file))
}
writeFileSync(join(bin, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`)
writeFileSync(
  join(bin, 'crew.js'),
  "#!/usr/bin/env node\nimport { runCrew } from './runner/crew.js'\n\nprocess.exitCode = runCrew(process.argv.slice(2), process.cwd(), line => console.log(line))\n",
)
