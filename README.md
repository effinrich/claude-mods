# claude-mods

Guardrails, compaction handoffs, drift checks and default skills for **Claude Code, Codex CLI, Gemini CLI, Cursor and Copilot CLI**. None of them call the model on their own.

## One-command install (every tool)

```
npx github:effinrich/claude-mods
```

It detects which of the five tools you have and wires each one up. Claude Code gets its plugins from this repo's marketplace. The others get command hooks that call a small Node runtime copied to `~/.claude-mods/runtime/<version>/`. Before editing any config file you own, it writes a `.claude-mods-backup-<time>` copy next to it.

| Command | Does |
|---|---|
| `npx github:effinrich/claude-mods install` | install (the default command) |
| `… update` | reinstall with your last choices, after a new version lands |
| `… uninstall` | remove only what it added (hook entries, `/ship` and `/checks`, copied skills, the marked instruction block) |
| `… doctor` | what is installed where, a stale Node path in the hooks, payload capture status, recent hook errors |
| `… project` | add shared claude-mods files to the repo you are in; `--remove` takes them out (see below) |

Options: `--tools claude,codex,gemini,cursor,copilot` (default: detected), `--mods guardrails,compaction-guard,context-audit,default-skills` (default: all), `--skills "ponytail:ponytail full"`, `--dry-run`.

Needs Node 20 or newer. MIT licensed.

### What each tool gets

| | Codex | Gemini CLI | Cursor | Copilot CLI |
|---|---|---|---|---|
| Block out-of-scope, lockfile and check-weakening edits | ✓ | ✓ | ◐ Write tool input is undocumented: blocked when a path is found | ◐ same for `edit`/`create` |
| Block made-up packages | ✓ | ✓ | ◐ | ◐ |
| Block destructive git and `--no-verify` | ✓ | ✓ | ✓ | ✓ |
| Commit gate on checks | ✓ | ✓ | ✓ | ✓ |
| Plain wording in commit, PR and issue text | ✓ | ✓ | ✓ | ✓ |
| End-of-turn check gate (2 retries) | ✓ Stop | ✓ AfterAgent | ✓ stop follow-up | ✓ agentStop |
| Long prompt saved as `.claude/spec.md` draft | ✓ | ✓ | ✓ | ✓ |
| Handoff saved before compaction | ✓ | ✓ | ✓ | ✓ |
| Handoff returned after compaction | ✓ SessionStart `compact` | ✓ next prompt | ◐ next session start | ◐ next session start |
| Drift check on global instruction files | ✓ | ✓ | ✓ | ✓ |
| `/ship` and `/checks` | skills (`$ship`) | `/ship` command | skills | skills |
| Default skills (ponytail, plain-writing) always on | ✓ AGENTS.md | ✓ GEMINI.md | ◐ skill copied; add the rule in Cursor Settings → Rules, or per repo with `project` | ✓ copilot-instructions.md |

The end-of-turn gate and the commit gate skip the check run when none of the files edited this session changed since the checks last passed.

Not ported: context-meter (these tools have no custom status line command) and cli-passthrough (it is specific to Claude Code's own CLI). The context-percentage hold is also missing, because none of these tools tell hooks how full the context is, and so is the research-first hold, because their hooks don't see reads and searches. They get the matching instruction line instead.

### First run in each tool

- **Codex**: hooks don't run until you approve them in `/hooks`.
- **Gemini CLI**: it lists the new hooks once for you to confirm.
- **Cursor**: restart Cursor.
- **Copilot CLI**: start a new session.

Then check it works: ask the agent to run `git reset --hard`. It should be refused with a `guardrails:` reason. If it isn't, run `doctor` and see `~/.claude-mods/hook.log`.

The hooks call Node by the absolute path it had at install time, so GUI apps without your shell's PATH still find it. After a Node upgrade (nvm, fnm, Homebrew) that path can disappear; `doctor` warns about it, and `update` fixes it.

### Shared repo setup

Run this inside a repo (any folder in it; the files go at the git root):

```
npx github:effinrich/claude-mods project [--mods ...] [--skills ...] [--dry-run] [--remove]
```

| File | What claude-mods writes |
|---|---|
| `.cursor/rules/claude-mods.mdc` | an always-applied Cursor rule (owned by claude-mods) |
| `AGENTS.md` | a marked block at the end; the rest of the file is left as is |
| `.claude/settings.json` | merged in: the `claude-mods` marketplace under `extraKnownMarketplaces` and `<mod>@claude-mods: true` under `enabledPlugins` |

The rule and the block carry the guardrails lines and one line per default skill. Each skill line points at `~/.agents/skills/<skill>/SKILL.md` and tells the agent to skip it when that file is missing, so teammates without the skill are not affected. `--mods` also accepts `context-meter` and `cli-passthrough` for the Claude Code settings. A plugin someone set to `false` in the settings stays off.

`--remove` takes out exactly what `project` added and deletes files it created. Before changing a file you already had, it saves a copy under `~/.claude-mods/backups/<repo>-<hash>/<time>/`, outside your working tree. Re-running is safe.

### Help pin the Cursor and Copilot edit fields

Cursor's `preToolUse` input for its Write tool and Copilot CLI's `toolArgs` for `edit` and `create` are not documented. The adapters try the likely field names and let an edit through when they find no path, so scope and lockfile blocks can miss there. (Cursor's `afterFileEdit` still marks the turn for the end-of-turn gate; Copilot has no such hook.) One real payload is enough to fix that:

1. Turn on capture with `CLAUDE_MODS_DEBUG=1` in the tool's environment, or add `"debug": true` to `~/.claude-mods/config.json` (a reinstall keeps it).
2. Ask the agent to create or edit a small file.
3. Open `~/.claude-mods/payloads.log`. Each line has the tool, event, top-level keys, argument keys and the payload with long strings cut at 200 characters.
4. Send one `preToolUse` line for a Write (Cursor) or `edit`/`create` (Copilot) in a GitHub issue. Check it first: it holds part of the file content and your paths.

Turn capture off again afterwards. The log rolls over at 2 MB.

## New users and teams

1. **Each person, once per machine**: install Node 20 or newer, then run `npx github:effinrich/claude-mods`. Hooks and skills live in each user's own config, so nobody can install them for someone else.
2. **Each shared repo, once**: run `npx github:effinrich/claude-mods project` and commit `.cursor/rules/claude-mods.mdc`, `AGENTS.md` and `.claude/settings.json`. Claude Code then offers the claude-mods plugins to everyone who opens the repo.
3. **Default skills**: `plain-writing` ships with claude-mods, so everyone gets it. `ponytail` and `feature-based-architecture` are not part of this repo; each person's install copies them from their own Claude Code installs into `~/.agents/skills/`. Anyone who lacks a skill just skips it; nothing breaks.
4. **First-run approvals**, per person and tool:
   - Claude Code: when you open the repo, accept the claude-mods marketplace and the plugins it lists.
   - Codex: approve the hooks in `/hooks`; they do not run until you do.
   - Gemini CLI: confirm the new hooks when it lists them.
   - Cursor: restart Cursor.
   - Copilot CLI: start a new session.

Then run `doctor` to check, and the `git reset --hard` test above.

## Claude Code mods

These run inside Claude Code's plugin engine. Guardrails adds one short system prompt line (scope, Suggestions, no invented APIs, prefer established libraries and their existing APIs), which you can turn off.

### guardrails

Enforcement by blocking, not by instructions in a markdown file.

**Spec.** Put the task in `.claude/spec.md`:

```markdown
---
scope: [src/features/auth/**, tests/auth/**]   # where Claude may edit; empty means anywhere
forbid: [package.json, "**/*.snap"]            # never edit these
checks: [pnpm typecheck, pnpm test auth]       # must pass; empty means typecheck + lint scripts
---
Add OAuth login. Acceptance: ...
```

A prompt over 1500 characters with no spec yet is saved there as a draft for you to fill in.

**What it blocks**

- Edits outside `scope` or inside `forbid`. The deny tells Claude to list the change under "Suggestions:" instead, so ideas still reach you.
- Imports of packages that are neither installed nor declared in any `package.json` above the file (type-only imports, relatives, tsconfig path aliases and Node builtins are fine).
- Edits that weaken checks: `.skip` / `.only`, `@ts-ignore`, `eslint-disable`, new `any` types, `vi.mock`/`jest.mock` of your own modules (relative paths). Only what the edit adds counts.
- Edits that remove assertions from a test file (`expect(`, `assert(`, `.should`) or lower a coverage threshold in the test config.
- Snapshot rewrites: `vitest -u`, `jest --updateSnapshot`, `pnpm test -- -u`, `playwright --update-snapshots`.
- Hand edits to lockfiles.
- `git commit`, `git tag` and `gh pr`/`gh issue` text with an em dash or a stock phrase (delve, seamless, leverage, robust, comprehensive, "it's worth noting", "I hope this helps"). Claude rewords it and runs the command again. The list is short so it rarely fires on real text.
- `--no-verify`, `git commit -n`, `git push --force` (lease is fine), `git reset --hard`, `git checkout -- .`, `git clean -f`, `rm -rf ~` or `/`. You can still run these yourself with `!`.
- Finishing a turn that edited code while checks fail. Claude is sent back up to 2 times, then stops and reports.
- `git commit` while checks fail.

**What it holds back once**

- A new source file of 150+ lines that imports a library the session hasn't searched, read under `node_modules/`, or fetched docs for. Claude is told to check the library's docs, repo examples and source for an existing API first; writing the file again goes through. React, Vue, Svelte, Next and similar frameworks don't count.

- A long new prompt when context is over 75%: held once with a nudge to `/clear` (and `/handoff-load`); send it again to go ahead.

**Commands**

- `/ship` runs checks and, only if they pass, has Claude commit, push and open a draft PR.
- `/checks` runs the checks now.
- `/guard` shows status; `/guard off` and `/guard on` switch it for the session.

Settings in `/config`: end-of-turn gate, system prompt line, spec drafts, writing check, research hold size (0 turns it off), context hold threshold, extra allowed imports, check timeout.

### default-skills

Pins skills into the system prompt of every session, as if you had run them at the start, and keeps them on through compaction (no more re-running `/ponytail:ponytail full` after a compact). It reads each skill from your own installs (plugin cache, `~/.claude/skills`, skills synced from your claude.ai account, or the project's `.claude/skills`), so no third-party skill text lives in this repo. A configured skill you don't have is skipped. The one exception is `plain-writing`, which this repo wrote and ships.

- Default: `ponytail:ponytail full, feature-based-architecture, default-skills:plain-writing`. Change the list in `/config` (comma-separated, `plugin:skill args`).
- `plain-writing` (about 400 tokens per turn) covers anything a person reads: lead with the answer, plain words, no em dashes or formula (not-X-but-Y, groups of three), length that fits, and no "done" or "tests pass" without having run them. Drop it from the list to turn it off.
- `/default-skills` shows what is pinned, from where, and roughly how many tokens it adds per turn.
- Each pinned skill is sent with every turn (cached with the system prompt), and is cut at 16,000 characters.
- Skills that run shell commands while they expand (`!` lines) are pinned as written, not run.

### compaction-guard

Before each compaction it saves the original task, the latest plan, todos, recent prompts and touched files to `~/.claude/handoffs/<project>-<hash>.md`. After the compaction it adds that handoff back into context. Three compactions within ten minutes raise a warning to fork.

- `/handoff` saves the handoff now.
- `/handoff-load` loads this project's last handoff into a fresh session.

### context-audit

Five seconds after a session starts it measures the fixed context every turn carries and shows it in the status line (`ctx base 46k`). It toasts only when that number is over your limit and is new or has grown by more than 10%. It also compares global CLAUDE.md files, enabled plugins and user hooks with the last session, and marks added lines that fetch remote content.

- `/context-audit` prints the breakdown.

### context-meter

Status line: `ctx 62% ⚠ · $3.41 · 2× compacted · 5h 72% · opus-5-5`. Warns at 60%, suggests forking at 80% (both in `/config`). The rate limit appears once a window passes 50%.

### cli-passthrough

Typing `claude plugin install x@y`, `claude mcp add …` or several of them joined by `&&` at the prompt runs them directly and shows the output, with no model turn. Anything with other shell syntax goes to the model as usual.

### crew

A lead agent plans a goal as a graph of tickets, then runs specialist agents in parallel, each in its own git worktree, and merges their work into one branch.

- `/crew:crew-plan <feature> <goal>`: the lead reads the code, asks you the open questions (numbered, each with a recommendation), then writes `.claude/crew/<feature>/plan.md` and one file per ticket. Each ticket names a role (`designer`, `frontend`, `backend`, `tester`, `docs`), the files it owns, what blocks it and its checks. You approve the graph before anything runs.
- `/crew:crew-run <feature>`: the lead creates the branch `crew/<feature>`, starts every unblocked ticket at once (8 by default; a run can ask for more after a cost check), and merges each finished ticket. A merge goes through only when the specialist touched no files outside its ticket, its checks pass, and the plan's full checks pass after the merge; otherwise the merge is undone and the specialist is sent back once. At the end the `reviewer` agent checks the whole branch against the tickets, and `/ship` opens the draft PR.
- `/crew [feature]` shows every ticket's state.

How the agents stay out of each other's way:
- Two tickets run at the same time only if their files can't overlap. Shared files (`package.json`, `tsconfig*.json`, `.github/**`, plus the plan's `shared` list) belong to the lead; specialists ask for changes under "Suggestions:".
- Guardrails reads each worktree's ticket and blocks edits outside it, and `crew merge` checks the diff again, so a shell edit can't slip past.
- Specialists run in Claude Code's own worktree isolation. crew sets `worktree.baseRef` to `"head"` in `.claude/settings.local.json` so their worktrees start from the run branch.

Things to know:
- Each worktree is a full checkout and runs an install (`setup:` in the plan; `none` turns it off). pnpm keeps that fast.
- Worktrees live under `.claude/worktrees/`. If your test or lint config scans every folder, exclude `.claude/`.
- Parallel width is limited by how independent the tickets are, not only by the cap. Every agent costs a full context.
- The same CLI works outside Claude Code: `npx github:effinrich/claude-mods crew status <feature>`.

### Install (Claude Code only)

At the prompt of a terminal session, one line per mod you want:

```
/plugin install guardrails --marketplace effinrich/claude-mods
/plugin install compaction-guard --marketplace effinrich/claude-mods
/plugin install context-audit --marketplace effinrich/claude-mods
/plugin install context-meter --marketplace effinrich/claude-mods
/plugin install cli-passthrough --marketplace effinrich/claude-mods
/plugin install default-skills --marketplace effinrich/claude-mods
/plugin install crew --marketplace effinrich/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. From a shell, use `claude plugin install <mod> --marketplace effinrich/claude-mods`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `effinrich/claude-mods`, then Add plugin.


## Skills that pair well, and ones to skip

These were reviewed for this repo on 2026-10-19. None are bundled.

- **Matt Pocock's skills** (github.com/mattpocock/skills, MIT): use on demand. His flow is `grill-me`, then `to-spec`, `to-tickets`, then `implement` with `tdd`. It fits guardrails: the end-of-turn gate runs after his red-green cycle finishes inside a turn, and his ticket files live in `.scratch/`, not `.claude/spec.md`. Two things to know. His specs leave out file paths, so put the paths a ticket may touch in `.claude/spec.md` `scope` yourself. And give prefactor tickets their own scope, or the scope block will stop them.
- **Claude Code `/goal`**: use on demand with a check as the goal ("`pnpm test` passes and …"). Guardrails still blocks bad edits and commits inside the loop. Avoid third-party goal loops with high continuation caps.
- **humanizer** (blader/humanizer): good for a one-off rewrite of a long document. At about 7,000 tokens it is too big to pin; `plain-writing` covers the same ground in about 400.
- **superdesign**: skipped. It sends your code to a hosted service and needs an account.
- **ultrawork** (oh-my-claudecode, MIT): skipped. The main repo retired it in v5.0.0 in favour of `/oh-my-claudecode:execute`. Its persistent mode used a Stop hook that kept blocking (capped at 50 to 500 passes) even with no todos left. Next to the guardrails gate that would override the 2-retry limit and bury the "checks fail" message under "do not stop". The OpenCode version (oh-my-opencode) has a source-available license and reported runaway loops. Ideas worth borrowing by hand: plan parallel work in waves with a dependency list, route simple lookups to a cheaper model, and keep subagent reports short.

## Notes

- Where an organization manages Claude Code, hooks on compaction, the system prompt and Stop only run for plugins the organization lists in managed settings.
- `context-audit` records your current setup on its first run and only reports changes after that, so review your global CLAUDE.md once yourself.
- Run the tests with `claude plugin test <plugin folder>`.

## Developing

- Shared logic lives in `core/`. Each Claude plugin carries a generated copy, so after editing `core/` run `npm run build`; it syncs the copies and compiles `dist/`.
- `dist/` is committed, because `npx github:` installs run no build step.
- Tests: `npm test` covers the runner, adapters and installer; `npm run check` checks the core copies and types; `claude plugin test <plugin>` covers each Claude mod. CI runs the first two on Node 20 and 22 and fails when `dist/` does not match a fresh build.
