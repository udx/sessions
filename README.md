# Sessions

Search, browse, and export Claude Code, Codex, and Kimi session transcripts from the command line.

Sessions reads the local transcripts stored by Claude Code, Codex, and Kimi Code and provides full-text search, filtering, recap, and export across all three tools. Commands search all sources by default; use `--source claude`, `--source codex`, or `--source kimi` to narrow them.

| Source | Sessions | Prompt history |
|--------|----------|----------------|
| Claude Code | `~/.claude/projects/` | `~/.claude/history.jsonl` |
| Codex | `~/.codex/sessions/` and `~/.codex/archived_sessions/` | `~/.codex/history.jsonl` |
| Kimi Code | `~/.kimi-code/sessions/` and `~/.kimi/sessions/` (legacy) | `~/.kimi-code/user-history/` and `~/.kimi/user-history/` |

## Installation

```bash
npm install -g @udx/sessions
```

## Commands

### List sessions

```bash
sessions list
sessions list -p my-project -n 10
sessions list -p my-project --source codex
sessions list --since 2026-01-01 --full
```

### Search transcripts

```bash
sessions search "authentication bug"
sessions search "refactor" -p my-project -C 2
sessions search "refactor" -p my-project --source codex
sessions search "deploy" --since 2026-05-01
```

The `-C` flag shows surrounding conversation messages for context (not text lines within a message). Each context message is labeled `[you]`, `[claude]`, `[codex]`, or `[kimi]` so you can follow the conversation flow.

### Show a session

```bash
sessions show a1b2c3d4
sessions show 019f6b6e4311 --source codex
sessions show codex:019f6b6e4311
sessions show a1b2c3d4 --preview
sessions show a1b2c3d4 --assistant-only
sessions show a1b2c3d4 --no-tools -n 20
```

The `--preview` flag shows a compact list of the first few prompts, useful for quickly understanding what a session was about. Combine with `--assistant-only` to preview assistant responses instead.

Claude and Kimi short IDs use the first 8 UUID characters. Codex short IDs use the first 12 because its time-ordered UUIDs commonly share their first 8. If an ID exists in multiple sources, qualify it as `claude:<id>`, `codex:<id>`, or `kimi:<id>`.

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
sessions history -p /opt/sources/udx.dev --source codex
```

## Options

Browsing commands support `--json` for machine-readable output; `export` uses `--format json`. Session-bearing JSON objects include a `source` field.

| Option | Commands | Description |
|--------|----------|-------------|
| `--source <source>` | all | Search `all`, `claude`, `codex`, or `kimi` sessions (default `all`) |
| `-p, --project <path>` | list, search, history, recap, activity | Filter by project path (substring match) |
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

## Configuration

Sessions respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Tests and custom integrations can override the roots directly with `SESSIONS_CLAUDE_DIR`, `SESSIONS_CODEX_DIR`, and `SESSIONS_KIMI_DIR` (the Kimi override takes a single root; by default both `~/.kimi-code` and the legacy `~/.kimi` are scanned).

Codex CLI and desktop app sessions are both supported. Codex appends active sessions under date-based directories. Sessions scans those recursively, reads plain JSONL archives, filters internal/developer messages, and collapses Codex's adjacent event/response duplicates. Desktop Page context and plugin recommendations are excluded from prompts and search; actual user replies are retained. For sessions absent from `history.jsonl` (including desktop chats), `history` reads user prompts from the transcripts. Existing global history remains authoritative for sessions it contains. Compressed `.jsonl.zst` archives are not currently read.

Kimi Code sessions come in two on-disk generations, and both are read. Modern sessions live under `~/.kimi-code/sessions/wd_<slug>_<hash>/session_<uuid>/`; the project path and title come from `state.json` and the transcript is reconstructed from the main agent's event-sourced `agents/main/wire.jsonl` (user inputs from `context.append_message` events with `origin.kind: user`, assistant output grouped per step, model from `llm.request`). Legacy sessions under `~/.kimi/sessions/<md5(workdir)>/<uuid>/` are read from the ready-made `context.jsonl`, with the project path resolved through `kimi.json`'s `work_dirs` or, failing that, the session's system prompt. Kimi's `user-history` files carry no timestamps, so those history entries sort after timestamped ones; thinking blocks, tool results, and injected system reminders are never shown or searched.

## Changelog

### 1.6.1
- Fixed Codex desktop Page context and plugin recommendations appearing as user prompts
- Added transcript-based history for Codex sessions absent from CLI global history
- Added desktop-format regression tests, including custom tools and environment overrides

### 1.6.0
- Added Kimi Code session discovery, search, show, export, recap, activity, projects, and history support
- Reads both Kimi generations: modern `~/.kimi-code` wire-protocol sessions and legacy `~/.kimi` context sessions
- Reconstructs modern wire logs into per-step assistant messages, skipping injected reminders, thinking, and tool results
- Resolves Kimi project paths from `state.json`, `kimi.json` work_dirs, or the session system prompt
- Extended `--source` and qualified IDs (`kimi:<id>`) to all commands; added 15 hermetic Kimi tests

### 1.5.0
- Added Codex session discovery, search, show, export, recap, activity, projects, and history support
- Added `--source all|claude|codex` to every command; both sources are searched by default
- Added normalized Codex message parsing with duplicate suppression and internal-message filtering
- Added active and archived Codex discovery, fork-safe metadata selection, and source-qualified IDs
- Added 40 hermetic dual-source tests alongside the existing compatibility suite

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

Claude Code stores each session under `~/.claude/projects/<encoded-project>/`. Codex stores active rollouts under `~/.codex/sessions/YYYY/MM/DD/` and plain archived rollouts under `~/.codex/archived_sessions/`. Kimi Code stores sessions per working directory under `~/.kimi-code/sessions/` (and legacy `~/.kimi/sessions/`). Sessions normalizes all three formats while streaming files line by line. Project paths are resolved from Claude's session metadata, Codex's canonical `session_meta` record, or Kimi's `state.json` / `kimi.json` metadata.

## License

MIT
