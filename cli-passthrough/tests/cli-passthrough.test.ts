import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'

type World = { runs: (readonly string[])[]; logs: string[] }

const world = (on: On, exitCodes: readonly number[] = []): World => {
  const runs: (readonly string[])[] = []
  const logs: string[] = []
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    const exitCode = exitCodes[runs.length - 1] ?? 0
    return {
      value: { exitCode, stdout: `ok ${e.argv.join(' ')}`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return { runs, logs }
}

const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('runs a typed plugin install directly and drops the prompt', async ($, on) => {
  const { runs, logs } = world(on)

  const result = await submit($, 'claude plugin install i-have-adhd@i-have-adhd')

  expect(runs).toEqual([['claude', 'plugin', 'install', 'i-have-adhd@i-have-adhd']])
  expect(logs[0]).toContain('$ claude plugin install i-have-adhd@i-have-adhd')
  expect(result.drop).toContain('exit 0')
  expect(result.drop).toContain('/reload-plugins')
})

test('runs && chains in order and stops at the first failure', async ($, on) => {
  const { runs } = world(on, [1])

  const result = await submit(
    $,
    'claude plugin marketplace add BuilderIO/skills && claude plugin install builder-skills@builder-skills',
  )

  expect(runs).toEqual([['claude', 'plugin', 'marketplace', 'add', 'BuilderIO/skills']])
  expect(result.drop).toContain('exit 1')
  expect(result.drop).toContain('1 not run')
  expect(result.drop).not.toContain('/reload-plugins')
})

test('passes everything else to the model', async ($, on) => {
  const { runs } = world(on)

  for (const text of [
    'how do I install a claude plugin?',
    'claude plugin install x; rm -rf ~',
    'claude plugin install $(whoami)',
    'claude config set foo bar',
    'claude mcp serve',
  ]) {
    const result = await submit($, text)
    expect(result.text).toBe(text)
  }
  expect(runs).toHaveLength(0)
})

test('lists without suggesting a reload', async ($, on) => {
  world(on)

  const result = await submit($, 'claude mcp list')

  expect(result.drop).not.toContain('/reload-plugins')
})
