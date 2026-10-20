import type { EngineInterface, Register } from 'claude-code'

const CREW_DIR = '.claude/crew'

const features = async ($: EngineInterface, root: string): Promise<string[]> =>
  (await $.fs.list(`${root}/${CREW_DIR}`).catch(() => [])).filter(entry => entry.kind === 'dir').map(entry => entry.name)

// `/crew [feature]` prints the run's state straight from the crew CLI, without a model turn.
const crewStatus = async ($: EngineInterface, args: string): Promise<string> => {
  const root = await $.session.root()
  const names = args.trim() === '' ? await features($, root) : [args.trim()]
  if (names.length === 0) return 'No crew plans here yet. Start one with /crew:crew-plan <feature> <goal>.'
  const reports: string[] = []
  for (const name of names) {
    const ran = await $.process.run(['node', `${$.plugin.root}/bin/crew.js`, 'status', name], { cwd: root, timeoutMs: 30_000 })
    reports.push(`${ran.stdout}${ran.stderr}`.trim())
  }
  return reports.join('\n\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'crew', description: 'Crew runs: every ticket and its state.', argumentHint: '[feature]' })
    return result
  })

  on('command.run', { command: 'crew' }, async ($, e) => ({ text: await crewStatus($, e.args) }))
}
