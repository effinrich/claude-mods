import type { Register } from 'claude-code'
import { parseCliPrompts } from './command.ts'

const TIMEOUT_MS = 120_000
const OUTPUT_LINES = 40

const tail = (text: string): string => text.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n')

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    const commands = parseCliPrompts(e.text)
    if (commands === undefined) return next(e)

    const cwd = await $.session.cwd()
    const summaries: string[] = []
    let needsReload = false
    for (const command of commands) {
      const shown = command.argv.join(' ')
      const ran = await $.process.run(command.argv, { cwd, timeoutMs: TIMEOUT_MS })
      const output = tail([ran.stdout, ran.stderr].filter(part => part.trim() !== '').join('\n'))
      $.ui.log(`$ ${shown}\n${output || '(no output)'}`)
      summaries.push(`\`${shown}\` exit ${ran.exitCode}`)
      if (ran.exitCode !== 0) break
      needsReload ||= command.needsReload
    }

    const skipped = commands.length - summaries.length
    const notes = [
      skipped > 0 ? `stopped, ${skipped} not run` : '',
      needsReload ? 'run /reload-plugins to pick it up' : '',
    ].filter(note => note !== '')
    return { drop: `Ran directly, no model turn: ${summaries.join('; ')}.${notes.length ? ` ${notes.join('; ')}.` : ''}` }
  }).catch(($, e, next) => next(e))
}
