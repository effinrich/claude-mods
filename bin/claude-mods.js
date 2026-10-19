#!/usr/bin/env node
import { run } from '../dist/installer/main.js'

process.exitCode = run(process.argv.slice(2))
