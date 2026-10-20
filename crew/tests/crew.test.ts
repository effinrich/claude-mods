import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const ROOT = '/work/app'

const world = (on: On, dirs: readonly string[], status: string) => {
  const runs: string[][] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: dirs.map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: status, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

test('/crew prints every run straight from the crew CLI', async ($, on) => {
  const runs = world(on, ['orders'], 'crew orders on crew/orders (from main)')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run({ command: 'crew', args: '', origin: { kind: 'composer' } })

  expect(result.text).toContain('crew orders on crew/orders')
  expect(runs[0]?.slice(-2)).toEqual(['status', 'orders'])
  expect(runs[0]?.[1]).toContain('/bin/crew.js')
})

test('/crew says how to start when there is no plan', async ($, on) => {
  world(on, [], '')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const result = await $.command.run({ command: 'crew', args: '', origin: { kind: 'composer' } })

  expect(result.text).toContain('/crew:crew-plan')
})
