import { isAbsolute, join } from 'node:path'
import { str, type HookReply } from '../types.ts'

export const NOTHING: HookReply = { stdout: '', stderr: '', exitCode: 0 }

export const json = (value: unknown): HookReply => ({ stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 })

export const absolute = (path: string, cwd: string): string => (isAbsolute(path) ? path : join(cwd, path))

// First string field present, for tools whose argument names are not documented.
export const firstString = (record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = str(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

export const parseMaybeJson = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
