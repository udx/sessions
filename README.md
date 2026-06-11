# Sessions

Search, browse, and export Claude Code session transcripts from the command line.

Sessions reads the JSONL transcript files stored by Claude Code in `~/.claude/projects/` and provides full-text search, filtering, and export across every conversation you have had.

## Installation

```bash
npm install -g @udx/sessions
```

## Commands

### List sessions

```bash
sessions list
sessions list -p my-project -n 10
sessions list --since 2026-01-01 --full
```

### Search transcripts

```bash
sessions search "authentication bug"
sessions search "refactor" -p my-project -C 2
sessions search "deploy" --since 2026-05-01
```

The `-C` flag shows surrounding conversation messages for context (not text lines within a message). Each context message is labeled `[you]` or `[claude]` so you can follow the conversation flow.

### Show a session

```bash
sessions show a1b2c3d4
sessions show a1b2c3d4 --preview
sessions show a1b2c3d4 --assistant-only
sessions show a1b2c3d4 --no-tools -n 20
```

The `--preview` flag shows a compact list of the first few prompts, useful for quickly understanding what a session was about. Combine with `--assistant-only` to preview Claude's responses instead.

### List projects

```bash
sessions projects
```

### Export a session

```bash
sessions export a1b2c3d4
sessions export a1b2c3d4 -f json -o transcript.json
sessions export a1b2c3d4 -f text
```

### Recap recent work

```bash
sessions recap -p my-project
sessions recap -p my-project --days 7 -n 5
sessions recap --days 30 --prompts 5 --json
```

Shows recent sessions grouped by day with user prompts listed under each session. Designed for quickly answering "what have we been working on?"

### Activity timeline

```bash
sessions activity
sessions activity --days 14 -n 20
```

Shows a compact cross-project timeline grouped by project. Useful for getting a high-level view of where work has been happening.

### Browse prompt history

```bash
sessions history
sessions history -s "deploy" -n 50
```

## Options

All commands support `--json` for machine-readable output.

| Option | Commands | Description |
|--------|----------|-------------|
| `-p, --project <path>` | list, search | Filter by project path (substring match) |
| `-n, --limit <n>` | list, search, show, history | Max results to display |
| `--since <date>` | list, search | Only sessions modified after this date |
| `--days <n>` | list, search, recap, activity | Sessions from last N days |
| `--full` | list | Include full message counts (slower) |
| `-C, --context <n>` | search | Surrounding conversation messages to show |
| `--preview` | show | Show first few prompts as a compact overview |
| `--user-only` | show | Show only user messages |
| `--assistant-only` | show | Show only assistant messages |
| `--no-tools` | show | Hide tool-use blocks |
| `--offset <n>` | show | Skip first N messages |
| `-f, --format <fmt>` | export | Output format: md, json, text |
| `-o, --output <file>` | export | Write to file instead of stdout |
| `--prompts <n>` | recap | Max user prompts per session (default 8) |
| `-s, --search <query>` | history | Filter history by prompt text |

## JSON output

The `--json` flag on `list` includes a `display` field (the first user prompt) for easy pipeline usage:

```bash
sessions list -n 5 --json | jq '.[].display'
```

Search results include `contextMessages` with `type`, `text`, and `position` fields when using `-C`.

## Changelog

### 1.4.0
- Added `recap` command for summarizing recent session activity by project, grouped by day
- Added `activity` command for cross-project timeline view
- Project filter (`-p`) now matches encoded directory names (e.g., `-opt-sources-www-udx-io`)
- Project filter is now case-insensitive

### 1.2.1
- Fixed `--preview --assistant-only` conflict (preview no longer forces user-only)
- Fixed `cleanSnippet` regex that corrupted search results for markdown-heavy content
- Simplified match count display to `(N matches in session)`

### 1.2.0
- Added `--preview` flag for quick session overviews
- Redesigned `-C` context to show surrounding conversation messages (not text lines)
- Added `display` field to `list --json` output
- Improved search snippet quality (strips markdown noise)
- Improved occurrence count display per session

### 1.1.0
- Fixed history command showing `(empty)` instead of prompt text
- Fixed `--no-tools` leaving blank message shells
- Fixed `--assistant-only` showing tool calls instead of text responses
- Fixed export producing empty blocks for tool-only messages
- Added `--since` date filter to search command
- Added per-session hit counts in search results

## How it works

Claude Code stores each session as a JSONL file under `~/.claude/projects/<encoded-project>/`. Sessions streams these files line by line, so it handles large transcripts without loading everything into memory. Project paths are resolved from the session metadata back to human-readable directory names.

## License

MIT
