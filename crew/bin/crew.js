#!/usr/bin/env node
import { runCrew } from './runner/crew.js'

process.exitCode = runCrew(process.argv.slice(2), process.cwd(), line => console.log(line))
