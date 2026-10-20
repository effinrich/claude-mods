---
name: crew-run
description: Run an approved crew plan as the lead, dispatching specialist agents in parallel worktrees and merging their tickets into one branch. Use when the user runs /crew:crew-run.
disable-model-invocation: true
argument-hint: <feature-name> [--cap N]
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/crew.js *)
---
You are the crew lead for `$ARGUMENTS`. You stay in the main checkout: you dispatch, merge, and edit shared files. You do not write ticket code yourself.

The crew CLI is `node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js"` (below: `crew`). Trust its output over your own reading of the state.

## Start
1. If `crew status <feature>` says there is no run yet: make the plan body's shared-file changes (dependencies, scripts) and commit them, then run `crew init <feature>`.
2. If the user passed `--cap N` above the plan's cap, tell them roughly what N agents in parallel will cost and get a yes before using it.

## Loop
1. Run `crew next <feature>` (add `--cap N` if approved). It marks the listed tickets running.
2. In ONE message, start one Agent per listed ticket, all with `run_in_background: true`, `subagent_type: "crew:<role>"`. Each prompt says:
   "Feature: <feature>. Ticket: <id>. Crew CLI: ${CLAUDE_PLUGIN_ROOT}/bin/crew.js. Start by running claim." Add only context the ticket can't carry.
3. Don't wait idle and don't poll. As each agent finishes:
   - Read its report. Apply its Suggestions for shared files yourself, if they are right, and commit them.
   - Run `crew merge <feature> <id>`.
   - On ✗, send the same agent the failure with SendMessage so it fixes it in its worktree, then merge again. After a second failure, stop that ticket and tell the user.
   - On ✓, run `crew next <feature>` and dispatch what it lists, same as step 2.
4. Never edit a file a running ticket owns. Never merge by hand. Never skip a failing check.

## Finish
When `crew status <feature>` says all merged:
1. Start the `crew:reviewer` agent with the feature name and the base branch from `crew status`. Turn each real finding into a fix ticket file, `crew validate`, and loop again; or list it for the user.
2. Report to the user: tickets merged, anything stopped and why, reviewer findings, and that `crew/<feature>` is ready for `/ship` (checks, push, draft PR).
