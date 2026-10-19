import { describe, expect, test } from 'claude-code/testing'
import { resolveChecks, packageManager } from '../hooks/checks.ts'
import { addedPackages, importedPackages, pathAliases } from '../hooks/imports.ts'
import { judgeCommand, judgeProse, judgeWeakening } from '../hooks/rules.ts'
import { globToRegExp, judgeScope, parseSpec } from '../hooks/spec.ts'

describe('spec', () => {
  test('reads inline and block lists from frontmatter', () => {
    const spec = parseSpec(
      ['---', 'scope: [src/auth/**, "tests/auth/**"]', 'forbid:', '  - package.json', 'checks:', '  - pnpm test auth', '---', 'Add OAuth.'].join('\n'),
    )
    expect(spec.scope).toEqual(['src/auth/**', 'tests/auth/**'])
    expect(spec.forbid).toEqual(['package.json'])
    expect(spec.checks).toEqual(['pnpm test auth'])
    expect(spec.body).toBe('Add OAuth.')
  })

  test('matches globs the way paths are written', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/c.ts')).toBe(false)
    expect(globToRegExp('docs/').test('docs/x/y.md')).toBe(true)
  })

  test('judges scope, forbid and the spec file itself', () => {
    const spec = parseSpec('---\nscope: [src/auth/**]\nforbid: [src/auth/legacy/**]\n---\n')
    expect(judgeScope('src/auth/login.ts', spec).isAllowed).toBe(true)
    expect(judgeScope('src/billing/x.ts', spec).isAllowed).toBe(false)
    expect(judgeScope('src/auth/legacy/old.ts', spec).isAllowed).toBe(false)
    expect(judgeScope('.claude/spec.md', spec).isAllowed).toBe(true)
    expect(judgeScope('anything.ts', undefined).isAllowed).toBe(true)
  })
})

describe('imports', () => {
  test('finds value imports and skips types, relatives, aliases and builtins', () => {
    const code = [
      "import type { Z } from 'zod'",
      "import { useQuery } from '@tanstack/react-query'",
      "import fs from 'node:fs'",
      "import path from 'path'",
      "import x from './x'",
      "import y from '@/y'",
      "export { a } from 'lodash-es/a'",
      "const r = require('chalk')",
      "await import('date-fns')",
    ].join('\n')
    expect(importedPackages(code).sort()).toEqual(['@tanstack/react-query', 'chalk', 'date-fns', 'lodash-es'])
  })

  test('counts only imports the edit adds', () => {
    expect(addedPackages("import a from 'a'\nimport b from 'b'", "import a from 'a'")).toEqual(['b'])
  })

  test('reads tsconfig path aliases through comments and trailing commas', () => {
    const tsconfig = '{ // c\n "compilerOptions": { "paths": { "@app/*": ["src/*"], "utils": ["u"], }, }, }'
    expect(pathAliases(tsconfig)).toEqual(['@app', 'utils'])
  })
})

describe('rules', () => {
  test('blocks destructive and hook-skipping commands', () => {
    for (const command of [
      'git commit --no-verify -m x',
      'git commit -nm "x"',
      'git push --force origin main',
      'git push -f',
      'git reset --hard HEAD~1',
      'git checkout -- .',
      'git restore .',
      'git clean -fd',
      'rm -rf ~',
      'rm -rf /',
    ]) {
      expect(judgeCommand(command)).toBeDefined()
    }
  })

  test('allows ordinary commands', () => {
    for (const command of [
      'git commit -m "fix: no-verify docs"',
      'git push --force-with-lease',
      'git push -u origin feat',
      'rm -rf node_modules',
      'git checkout -b feat',
      'git restore src/a.ts',
    ]) {
      expect(judgeCommand(command)).toBeUndefined()
    }
  })

  test('flags removed assertions, own-module mocks and lowered coverage', () => {
    expect(judgeWeakening("it('a', () => {})", "it('a', () => { expect(x).toBe(1) })", 'src/a.test.ts')).toBe('removes assertions from a test (1 → 0)')
    expect(judgeWeakening('expect(x).toBe(2)', 'expect(x).toBe(1)', 'src/a.test.ts')).toBeUndefined()
    expect(judgeWeakening("it('a', () => {})", "it('a', () => { expect(x).toBe(1) })", 'src/a.ts')).toBeUndefined()
    expect(judgeWeakening("vi.mock('./db')", '', 'src/a.test.ts')).toContain('mocks one of your own modules')
    expect(judgeWeakening("vi.mock('node:fs')", '', 'src/a.test.ts')).toBeUndefined()
    expect(judgeWeakening('thresholds: { lines: 60 }', 'thresholds: { lines: 80 }', 'vitest.config.ts')).toBe('lowers the lines coverage threshold from 80 to 60')
    expect(judgeWeakening('"branches": 70', '"branches": 90', 'package.json')).toBe('lowers the branches coverage threshold from 90 to 70')
    expect(judgeWeakening('thresholds: { lines: 90 }', 'thresholds: { lines: 80 }', 'vitest.config.ts')).toBeUndefined()
  })

  test('blocks snapshot rewrites but not ordinary test runs', () => {
    for (const command of ['vitest -u', 'npx jest --updateSnapshot', 'pnpm test -- -u', 'npm run test -- --update', 'npx playwright test --update-snapshots']) {
      expect(judgeCommand(command)).toContain('rewrites snapshots')
    }
    for (const command of ['pnpm vitest run', 'git push -u origin test', 'npm test', 'jest --coverage']) {
      expect(judgeCommand(command)).toBeUndefined()
    }
  })

  test('flags stock AI phrasing in commit, tag, PR and issue text only', () => {
    expect(judgeProse('git commit -m "Add login \u2014 with retries"')).toBe('the message uses an em dash')
    expect(judgeProse("gh pr create --title x --body 'A robust, seamless flow'")).toBe('the message uses "seamless", "robust"')
    expect(judgeProse('gh issue comment 4 --body "Let\'s delve into it"')).toBe('the message uses "delve"')
    expect(judgeProse("git commit -F - <<'EOF'\nIt's worth noting the cache\nEOF")).toBe('the message uses "it\'s worth noting"')
    expect(judgeProse('git commit -m "Retry the upload once on a 503"')).toBeUndefined()
    expect(judgeProse('echo "a robust, seamless thing \u2014 yes"')).toBeUndefined()
    expect(judgeProse('git log --grep robust')).toBeUndefined()
  })

  test('flags edits that weaken checks, only for what they add', () => {
    expect(judgeWeakening('it.skip("x", () => {})', '', 'a.test.ts')).toBe('skips or isolates tests')
    expect(judgeWeakening('// @ts-ignore\nfoo()', 'foo()', 'a.ts')).toBe('silences the type checker')
    expect(judgeWeakening('const a = b as any', 'const a = b', 'a.ts')).toBe('adds an `any` type')
    expect(judgeWeakening('const a = b as any', 'const a = b', 'a.js')).toBeUndefined()
    expect(judgeWeakening('// eslint-disable-next-line\nx()\ny()', '// eslint-disable-next-line\nx()', 'a.ts')).toBeUndefined()
  })
})

describe('checks', () => {
  test('uses spec checks first, else typecheck and lint scripts with the repo package manager', () => {
    expect(resolveChecks(['pnpm test core'], undefined, new Set())).toEqual([{ label: 'pnpm test core', argv: ['pnpm', 'test', 'core'] }])
    const packageJson = JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest' } })
    expect(resolveChecks([], packageJson, new Set(['pnpm-lock.yaml'])).map(c => c.label)).toEqual(['pnpm run typecheck', 'pnpm run lint'])
    expect(packageManager(new Set(['bun.lock']))).toBe('bun')
  })
})
