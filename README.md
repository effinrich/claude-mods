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
| `… doctor` | what is installed where, plus recent hook errors |

Options: `--tools claude,codex,gemini,cursor,copilot` (default: detected), `--mods guardrails,compaction-guard,context-audit,default-skills` (default: all), `--skills "ponytail:ponytail full"`, `--dry-run`.

The repo is private, so each machine needs a GitHub credential for it (`gh auth login`, then `gh auth setup-git`). Node 20 or newer.

### What each tool gets

| | Codex | Gemini CLI | Cursor | Copilot CLI |
|---|---|---|---|---|
| Block out-of-scope, lockfile and check-weakening edits | ✓ | ✓ | ◐ Write tool input is undocumented: blocked when a path is found | ◐ same for `edit`/`create` |
| Block made-up packages | ✓ | ✓ | ◐ | ◐ |
| Block destructive git and `--no-verify` | ✓ | ✓ | ✓ | ✓ |
| Commit gate on checks | ✓ | ✓ | ✓ | ✓ |
| End-of-turn check gate (2 retries) | ✓ Stop | ✓ AfterAgent | ✓ stop follow-up | ✓ agentStop |
| Long prompt saved as `.claude/spec.md` draft | ✓ | ✓ | ✓ | ✓ |
| Handoff saved before compaction | ✓ | ✓ | ✓ | ✓ |
| Handoff returned after compaction | ✓ SessionStart `compact` | ✓ next prompt | ◐ next session start | ◐ next session start |
| Drift check on global instruction files | ✓ | ✓ | ✓ | ✓ |
| `/ship` and `/checks` | skills (`$ship`) | `/ship` command | skills | skills |
| Default skills (ponytail) always on | ✓ AGENTS.md | ✓ GEMINI.md | ◐ skill copied; add the rule in Cursor Settings → Rules | ✓ copilot-instructions.md |

Not ported: context-meter (these tools have no custom status line command) and cli-passthrough (it is specific to Claude Code's own CLI). The context-percentage hold is also missing, because none of these tools tell hooks how full the context is.

### First run in each tool

- **Codex**: hooks don't run until you approve them in `/hooks`.
- **Gemini CLI**: it lists the new hooks once for you to confirm.
- **Cursor**: restart Cursor.
- **Copilot CLI**: start a new session.

Then check it works: ask the agent to run `git reset --hard`. It should be refused with a `guardrails:` reason. If it isn't, run `doctor` and see `~/.claude-mods/hook.log`.

## Claude Code mods

These run inside Claude Code's plugin engine. Guardrails adds one short system prompt line, which you can turn off.

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
- Edits that weaken checks: `.skip` / `.only`, `@ts-ignore`, `eslint-disable`, new `any` types. Only what the edit adds counts.
- Hand edits to lockfiles.
- `--no-verify`, `git commit -n`, `git push --force` (lease is fine), `git reset --hard`, `git checkout -- .`, `git clean -f`, `rm -rf ~` or `/`. You can still run these yourself with `!`.
- Finishing a turn that edited code while checks fail. Claude is sent back up to 2 times, then stops and reports.
- `git commit` while checks fail.

**What it holds back on you**

- A long new prompt when context is over 75%: held once with a nudge to `/clear` (and `/handoff-load`); send it again to go ahead.

**Commands**

- `/ship` runs checks and, only if they pass, has Claude commit, push and open a draft PR.
- `/checks` runs the checks now.
- `/guard` shows status; `/guard off` and `/guard on` switch it for the session.

Settings in `/config`: end-of-turn gate, system prompt line, spec drafts, context hold threshold, extra allowed imports, check timeout.

### default-skills

Pins skills into the system prompt of every session, as if you had run them at the start, and keeps them on through compaction (no more re-running `/ponytail:ponytail full` after a compact). It reads each skill from your own installs (plugin cache, `~/.claude/skills`, or the project's `.claude/skills`), so no third-party skill text lives in this repo.

- Default: `ponytail:ponytail full`. Change the list in `/config` (comma-separated, `plugin:skill args`).
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

### Install (Claude Code only)

At the prompt of a terminal session, one line per mod you want:

```
/plugin install guardrails --marketplace effinrich/claude-mods
/plugin install compaction-guard --marketplace effinrich/claude-mods
/plugin install context-audit --marketplace effinrich/claude-mods
/plugin install context-meter --marketplace effinrich/claude-mods
/plugin install cli-passthrough --marketplace effinrich/claude-mods
/plugin install default-skills --marketplace effinrich/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. From a shell, use `claude plugin install <mod> --marketplace effinrich/claude-mods`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `effinrich/claude-mods`, then Add plugin.

This repository is private. Installing needs read access on GitHub and a git credential for github.com on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.

## Notes

- Where an organization manages Claude Code, hooks on compaction, the system prompt and Stop only run for plugins the organization lists in managed settings.
- `context-audit` records your current setup on its first run and only reports changes after that, so review your global CLAUDE.md once yourself.
- Run the tests with `claude plugin test <plugin folder>`.

## Developing

- Shared logic lives in `core/`. Each Claude plugin carries a generated copy, so after editing `core/` run `npm run build`; it syncs the copies and compiles `dist/`.
- `dist/` is committed, because `npx github:` installs run no build step.
- Tests: `npm test` covers the runner, adapters and installer; `claude plugin test <plugin>` covers each Claude mod.
