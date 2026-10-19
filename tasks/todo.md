# Plan: one npx installer, mods across coding agents

Status: **v1 built (Codex, Gemini CLI, Cursor, Copilot CLI); opencode is v2.** Facts below come from each tool's official docs as of 2026-10-19; items marked (unverified) were not confirmed there.

## How it fits together

Claude Code mods run inside Claude Code's plugin engine. Codex CLI, Gemini CLI, Cursor and Copilot all run **command hooks** instead: a script gets JSON on stdin and answers with an exit code and JSON on stdout. opencode runs **JS/TS plugins**.

1. **`core/`**: the logic that already exists, moved out of the mods with no behavior change. That covers spec parsing and globs, the import check, destructive-command and check-weakening rules, check resolution, the handoff builder and the drift diff. Claude mods import it; the other tools reach it through the hook runner.
2. **Hook runner** (`bin/claude-mods-hook.js`, Node, no dependencies): `claude-mods-hook <tool> <event>`. Reads that tool's stdin JSON, converts it to one common shape, runs `core`, and writes the reply in that tool's format.
3. **opencode adapter**: a small plugin that calls the same `core`.
4. **Installer**: `npx github:effinrich/claude-mods <install|update|uninstall|doctor>`.
   - Detects which tools are installed.
   - Copies the runtime to `~/.claude-mods/<version>/`, because hooks need a stable path and npx's cache isn't one.
   - Merges hook entries into each tool's config: it backs the file up first, tags our entries, and re-running it is safe.
   - Claude Code still installs through its marketplace.

## What ports where

✓ works · ◐ partial · ✗ not possible with that tool's hooks

| Feature | Codex | Gemini | Cursor | Copilot | opencode |
|---|---|---|---|---|---|
| **guardrails**: block out-of-scope / lockfile / check-weakening edits | ✓ PreToolUse | ✓ BeforeTool | ✓ preToolUse | ✓ preToolUse | ✓ tool.execute.before (throws) |
| guardrails: block made-up packages | ✓ | ✓ | ✓ | ✓ | ✓ |
| guardrails: block destructive git / `--no-verify` | ✓ | ✓ | ✓ beforeShellExecution | ✓ | ✓ |
| guardrails: commit gate on checks | ✓ | ✓ | ✓ | ✓ | ✓ |
| guardrails: end-of-turn check gate (send back up to 2×) | ✓ Stop block | ✓ AfterAgent deny | ✓ stop followup_message | ✓ agentStop block | ✗ (no such hook found) |
| guardrails: long prompt → spec draft | ✓ UserPromptSubmit | ✓ BeforeAgent | ✓ beforeSubmitPrompt | ◐ (no block or inject in CLI) | ✓ chat.message |
| guardrails: hold new task at high context | ✗ no context % | ✗ | ✗ (only in preCompact) | ✗ | ✗ |
| guardrails: `/ship`, `/checks` | ◐ skill (prompts deprecated) | ✓ TOML command | ✓ .cursor/commands | ✓ plugin command | ✓ command md |
| **compaction-guard**: save handoff before compaction | ✓ PreCompact + transcript | ✓ PreCompress + transcript | ✓ preCompact + transcript | ◐ preCompact (notification) | ✓ session.compacting |
| compaction-guard: put the handoff back after | ◐ SessionStart source=compact (unverified) | ◐ next prompt via BeforeAgent | ◐ sessionStart (unverified after compaction) | ✗ | ✓ append to context |
| **context-audit**: drift check (instruction files, hooks) | ✓ SessionStart | ✓ | ✓ | ✓ | ✓ |
| context-audit: fixed-context token count | ✗ | ✗ | ✗ | ✗ | ✗ |
| **context-meter** status line | ✗ (built-in items only) | ✗ (toggles only) | ◐ CLI statusLine (schema unverified) | ◐ CLI statusLine (payload unverified) | ◐ TUI slot (types only) |
| **default-skills** (ponytail on by default) | ✓ skills + AGENTS.md | ✓ skills + GEMINI.md | ✓ skills + rule | ✓ skills + instructions | ✓ instructions |
| **cli-passthrough** | ✗ (Claude-specific) | ✗ | ✗ | ✗ | ✗ |

For the ✗ status line cells, the installer will switch on each tool's built-in context display where one exists (for example Gemini's `ui.footer.hideContextPercentage: false`).

## Phases

1. **Extract `core/`** with no behavior change. All 39 existing Claude-mod tests must stay green.
2. **Hook runner + Codex, Gemini, Cursor, Copilot adapters.** Contract tests feed each tool's documented stdin JSON and check the documented exit code and stdout.
3. **opencode adapter** as a JS plugin.
4. **Installer** with `install`, `update`, `uninstall` and `doctor` (doctor shows what's installed where and whether each tool still needs the hooks approved), plus `--tools`, `--mods`, `--scope user|project` and `--dry-run`.
5. **default-skills port**: link the chosen skills (ponytail) into each tool's skills folder or instructions, read from your installed copy and never copied into the repo.
6. README, then push.

## Risks and limits, up front

- **Hooks must be approved once per tool.** Codex runs non-managed hooks only after review in `/hooks`. Gemini warns when project hooks change. Codex project hooks also require a trusted project.
- **I can't run the real agents here.** Their hooks only fire during model turns, which need your API keys. Verification is contract tests against the documented formats, plus a `doctor` command and a 2-minute smoke test you run per tool. Anything that doesn't match the docs gets fixed from your report.
- **Formats differ per tool.** Edit-tool names and inputs vary (Codex `apply_patch` patches, Cursor `edits[]`, Copilot `toolArgs`). Each adapter extracts the paths and new text. Patch-format parsing is the riskiest piece.
- **Gemini CLI note.** Gemini CLI was replaced by Antigravity CLI for free and Google One users on 2026-06-18. Gemini CLI support covers paid and API-key users only.
- **Private repo.** Installing needs a GitHub credential on each machine (`gh auth setup-git`).

## Open decisions

- Tools for v1: all five, or Codex + Gemini + Cursor + Copilot first, with opencode in a v2? (Recommended: the four command-hook tools first, since they share about 90% of the code.)
- Default scope: user-wide (recommended) or per project?
