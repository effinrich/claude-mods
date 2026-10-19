# claude-mods

Claude Code mods. None of them call the model on their own; guardrails adds one short system prompt line, which you can turn off.

## guardrails

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

## compaction-guard

Before each compaction it saves the original task, the latest plan, todos, recent prompts and touched files to `~/.claude/handoffs/<project>-<hash>.md`. After the compaction it adds that handoff back into context. Three compactions within ten minutes raise a warning to fork.

- `/handoff` saves the handoff now.
- `/handoff-load` loads this project's last handoff into a fresh session.

## context-audit

Five seconds after a session starts it measures the fixed context every turn carries and shows it in the status line (`ctx base 46k`). It toasts only when that number is over your limit and is new or has grown by more than 10%. It also compares global CLAUDE.md files, enabled plugins and user hooks with the last session, and marks added lines that fetch remote content.

- `/context-audit` prints the breakdown.

## context-meter

Status line: `ctx 62% ⚠ · $3.41 · 2× compacted · 5h 72% · opus-5-5`. Warns at 60%, suggests forking at 80% (both in `/config`). The rate limit appears once a window passes 50%.

## cli-passthrough

Typing `claude plugin install x@y`, `claude mcp add …` or several of them joined by `&&` at the prompt runs them directly and shows the output, with no model turn. Anything with other shell syntax goes to the model as usual.

## Install

At the prompt of a terminal session, one line per mod you want:

```
/plugin install guardrails --marketplace effinrich/claude-mods
/plugin install compaction-guard --marketplace effinrich/claude-mods
/plugin install context-audit --marketplace effinrich/claude-mods
/plugin install context-meter --marketplace effinrich/claude-mods
/plugin install cli-passthrough --marketplace effinrich/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. From a shell, use `claude plugin install <mod> --marketplace effinrich/claude-mods`. In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `effinrich/claude-mods`, then Add plugin.

This repository is private. Installing needs read access on GitHub and a git credential for github.com on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.

## Notes

- Where an organization manages Claude Code, hooks on compaction, the system prompt and Stop only run for plugins the organization lists in managed settings.
- `context-audit` records your current setup on its first run and only reports changes after that, so review your global CLAUDE.md once yourself.
- Run the tests with `claude plugin test <plugin folder>`.
