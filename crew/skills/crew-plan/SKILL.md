---
name: crew-plan
description: Turn a goal into a crew plan, a graph of tickets each owned by one specialist (designer, frontend, backend, tester, docs), ready for /crew:crew-run. Use when the user runs /crew:crew-plan.
disable-model-invocation: true
argument-hint: <feature-name> <goal>
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/bin/crew.js *)
---
Plan the goal in `$ARGUMENTS` as a crew run. The first word is the feature name (letters, digits, `-`, `_`, `.`); the rest is the goal.

## 1. Understand it
- Read the code the goal touches first, so you ask only what the code can't answer.
- Then ask the user, in rounds, every decision that blocks the plan: numbered, each with your recommended answer. Stop when nothing is open. Do not write tickets before the user confirms the shared understanding.

## 2. Slice it
- Each ticket is a thin, complete, checkable piece: one role, one context window of work.
- Prefer vertical slices. Put contracts first (shared types, API shapes, design tokens) as their own small tickets, so later tickets can run in parallel against them.
- `owns` lists the globs a ticket may edit. Tickets that can run at the same time must own different files. When two must touch one file, chain them with `blockedBy`.
- Shared files (`package.json`, `tsconfig*.json`, `.github/**`, plus anything in the plan's `shared`) belong to the lead. No ticket owns them. List dependency or script changes in the plan body so the lead makes them before the run.
- Each ticket's `checks` runs fast in its worktree: the tests and typecheck for its own files. The plan's `checks` is the full suite the lead runs after every merge.
- Add a `tester` ticket for each behaviour with acceptance criteria, and a `docs` ticket at the end if anything user-facing changes. Plan no reviewer ticket; the lead runs the reviewer at the end.

## 3. Write it
`.claude/crew/<feature>/plan.md`:
```markdown
---
goal: one line
checks: [pnpm typecheck, pnpm test]
shared: [src/routes.ts]
cap: 8
---
Context, decisions made in step 1, and the lead's own changes (dependencies, shared files).
```
`.claude/crew/<feature>/tickets/NN-slug.md`, numbered in a sensible order:
```markdown
---
role: backend
owns: [src/server/orders/**]
reads: [src/shared/order.ts]
blockedBy: [01-order-types]
checks: [pnpm vitest run src/server/orders]
---
# Orders API
What to build, the contract to keep, and acceptance criteria as a checklist.
```
Don't write file contents or code into tickets beyond the contracts.

## 4. Check it
Run `node "${CLAUDE_PLUGIN_ROOT}/bin/crew.js" validate <feature>` and fix every error. Show the user the ticket list (id, role, owns, blockedBy) and the warnings, and ask for approval. When approved, tell them to run `/crew:crew-run <feature>`.
