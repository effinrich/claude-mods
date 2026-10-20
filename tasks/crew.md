# Plan: crew, a planner that hands tickets to specialist agents in parallel

Status: **v1 built (crew 0.1.0), Claude Code only.** Decisions taken: the lead works in the main checkout, cap 8 by default and raised per run after a cost check, tickets in `.claude/crew/`, one integration branch and one draft PR. Specialists use Claude Code's own subagent worktree isolation (`isolation: worktree`, with `worktree.baseRef: "head"`), not worktrees crew creates; `crew claim` writes the ticket marker into each one. See the README's crew section for how it runs.

## The idea

A lead agent, working in the main checkout, turns a goal into a graph of tickets. Each ticket has a role (design, frontend, backend, data, tests, docs), the files it owns, what blocks it, and how it is checked. Every ticket whose blockers are done goes to a specialist agent in its own git worktree, all at once. The lead merges finished tickets into one integration branch, runs the checks after each merge, and dispatches the next wave. At the end there is one branch and one draft PR.

This follows Matt Pocock's `to-tickets` and `implement-spec`, with one addition: guardrails enforces each ticket's file ownership, so parallel agents cannot edit each other's files even when they try to.

## Pieces

1. **Specialist agents** (`crew/agents/*.md`), each with a narrow prompt, a tool allowlist and a model:
   - `designer`: UI structure, design tokens, components. No backend files.
   - `frontend`: components, state, routing, against the designer's output.
   - `backend`: API, services, data access, migrations.
   - `tester`: writes the tests for a ticket's acceptance criteria, test-first where the ticket asks for it.
   - `docs`: README, ADRs, API docs, changelog.
   - `reviewer`: read-only. Reads the merged diff against the ticket and the spec, and reports problems.
   Cheap work (lookups, docs) goes to a cheaper model; design-heavy work goes to the strongest one.
2. **`/crew-plan`**: interviews the user until the goal is clear (grill style, numbered questions, each with a recommended answer), then writes `.claude/crew/<feature>/tickets/NN-slug.md`:
   ```markdown
   ---
   role: backend
   owns: [src/server/orders/**, tests/server/orders/**]
   reads: [src/shared/types/order.ts]
   blockedBy: [01-order-types]
   checks: [pnpm vitest run tests/server/orders]
   ---
   Acceptance: ...
   ```
   The user approves the graph before anything runs.
3. **`/crew-run`**: the lead's loop.
   - Pick the frontier: tickets whose blockers are merged and whose `owns` does not overlap any running ticket's.
   - For each one, create a worktree off the integration branch, write the ticket into that worktree's `.claude/spec.md` (`scope` = `owns`, `checks` = `checks`), and start the role's agent there.
   - When an agent finishes: its worktree checks must pass (the guardrails stop gate already makes the agent fix them), then the lead merges it, runs the full checks, and either moves on or sends a fix ticket back.
   - Stops at the concurrency cap, on a budget limit, or when a ticket fails twice. It never loops without a failing check.
4. **Guardrails hooks, extended**:
   - Inside a crew worktree, edits outside `owns` are denied with "this file belongs to ticket NN". The scope block already does this; it just reads the ticket.
   - Shared hot files (`package.json`, route tables, barrel `index.ts` files) belong to the lead only. Agents request changes under "Suggestions:", and the lead applies them between waves. This is what keeps 50+ agents from colliding.
5. **Status**: `/crew` shows the graph: queued, running (which agent, how long), merged, failed.

## What limits the number of agents

- **The graph's width.** Agents can only run at once when their tickets are independent. Most features have 3 to 10 independent tickets at a time, so 56 or 80 agents needs a big goal split very finely, or several goals at once.
- **Merge conflicts in shared files.** Handled by giving those files to the lead (above). Without that, a wide run fails at merge time.
- **Cost and rate limits.** Every agent costs a full context. 50 agents for an hour is a real bill. The cap and a token budget are settings, with a low default and a confirmation before a run over it.
- **Disk.** Each worktree is a full checkout, plus `node_modules` unless the package manager shares a store (pnpm does).
- **Claude Code's own limits** on concurrent subagents. To be measured before setting the default.

## Next

- Measure Claude Code's limit on concurrent background subagents and set the cap's ceiling from it.
- A token budget per run, read from session usage.
- Codex, Gemini, Cursor and Copilot: the CLI and the ownership hook already work there; they need a lead skill once their subagent support can isolate worktrees.
