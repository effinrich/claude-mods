import { describe, expect, test } from 'claude-code/testing'
import { resolveChecks, packageManager } from '../hooks/checks.ts'
import { addedPackages, importedPackages, pathAliases } from '../hooks/imports.ts'
import { judgeCommand, judgeWeakening } from '../hooks/rules.ts'
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
