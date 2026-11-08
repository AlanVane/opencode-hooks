# format-code

> Auto-formats Python (ruff) and JS/TS/HTML/JSON/MD/YAML (oxfmt or prettier, whichever the project uses) the moment Claude edits them.

A `PostToolUse` hook fires after every `Write` and `Edit` call, resolves the file path (relative paths resolve against the session cwd), picks a formatter by extension, and formats the file in place: `uv run ruff check --fix` then `uv run ruff format` for `.py`, and the project's own formatter for `.js`, `.ts`, `.json`, `.md`, `.yaml`, `.yml`, and `.html`. File paths are passed as argv, never through a shell, so filenames with shell metacharacters cannot inject commands. Unsupported extensions and missing files are skipped silently, a formatter failure never blocks the session, and every outcome (FORMATTED / SKIP / ERROR) is logged.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install format-code@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install format-code@claude-code-hooks`.)

## What it does

| Event                       | Runs | What happens                                                                                                                                               |
| --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostToolUse (`Write\|Edit`) | sync | Formats the touched file in place with ruff (Python) or the project's formatter (oxfmt / prettier), then returns `{}` so the session continues either way. |

## Formatter selection

Prettier's defaults are not the project's style, so the hook looks up the closest `package.json` above the edited file and picks:

1. **oxfmt** when the project has `.oxfmtrc*` / `oxfmt.config.*` / an `oxfmt` key, or lists `oxfmt` in its dependencies
2. **prettier** when the project has a `.prettierrc*` / `prettier.config.*` file or lists `prettier` in its dependencies
3. **prettier** as a compatibility fallback for projects that declare neither

When the project has `node_modules/.bin/oxfmt` or `node_modules/.bin/prettier`, that pinned binary is used instead of `npx --yes`, so the project's exact version and config apply. An oxfmt project is never reformatted with prettier: if oxfmt exits non-zero the file is left untouched and the reason is logged.

## Configuration

No configuration needed, and no environment variables to set. Logs go to `~/.claude/hooks-logs/<date>.jsonl` (the log directory is derived from `$HOME`).

## Data & privacy

Rewrites the edited file in place and records file paths, formatter outcomes, and session ids in the local log. The hook itself makes no network calls; the one indirect exception is `npx --yes prettier` / `npx --yes oxfmt`, which downloads the formatter from the npm registry the first time if it is not installed locally.

## Uninstall

```
/plugin uninstall format-code@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), a collection of production-ready Claude Code hooks, each installable on its own as a plugin.
