# claude-mods

Two Claude Code mods. Both run locally and never call the model.

## compaction-guard

Before each compaction it saves the original task, the latest plan, todos, recent prompts and touched files to `~/.claude/handoffs/<project>-<hash>.md`. After the compaction it adds that handoff back into context, so the plan survives. Three compactions within ten minutes raise a warning to fork.

- `/handoff` saves the handoff now.
- `/handoff-load` loads this project's last handoff into a fresh session.

Settings in `/config`: handoff path (empty keeps it out of the repo), thrash count, thrash window.

## context-audit

Five seconds after a session starts it measures the fixed context every turn carries and shows it in the status line (`ctx base 46k`). It toasts only when that number is over your limit and is new or has grown by more than 10%. It also compares global CLAUDE.md files, enabled plugins and user hooks with the last session, and marks added lines that fetch remote content.

- `/context-audit` prints the breakdown.

Settings in `/config`: warning threshold (default 30k tokens).

## Install

At the prompt of a terminal session:

```
/plugin install compaction-guard --marketplace effinrich/claude-mods
/plugin install context-audit --marketplace effinrich/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install compaction-guard --marketplace effinrich/claude-mods
claude plugin install context-audit --marketplace effinrich/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `effinrich/claude-mods`, then Add plugin.

This repository is private. Installing needs read access on GitHub and a git credential for github.com on the machine (an SSH key, or `gh auth login` then `gh auth setup-git`). The install never prompts for one.

## Notes

- Where an organization manages Claude Code, `compaction-guard`'s compaction hook only runs if the organization lists the plugin in managed settings.
- `context-audit` records your current setup on its first run and only reports changes after that, so review your global CLAUDE.md once yourself.
- Run the tests with `claude plugin test <plugin folder>`.
