import type { Adapter, ToolName } from '../types.ts'
import { codex } from './codex.ts'
import { copilot } from './copilot.ts'
import { cursor } from './cursor.ts'
import { gemini } from './gemini.ts'

export const ADAPTERS: Readonly<Record<ToolName, Adapter>> = { codex, gemini, cursor, copilot }
