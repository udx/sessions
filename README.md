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
sessions search "refactor" -p my-project -C 3
```

### Show a session

```bash
sessions show a1b2c3d4
sessions show a1b2c3d4 --user-only
sessions show a1b2c3d4 --no-tools -n 20
```

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
| `--since <date>` | list | Only sessions modified after this date |
| `--full` | list | Include full message counts (slower) |
| `-C, --context <n>` | search | Context lines around each match |
| `--user-only` | show | Show only user messages |
| `--assistant-only` | show | Show only assistant messages |
| `--no-tools` | show | Hide tool-use blocks |
| `--offset <n>` | show | Skip first N messages |
| `-f, --format <fmt>` | export | Output format: md, json, text |
| `-o, --output <file>` | export | Write to file instead of stdout |
| `-s, --search <query>` | history | Filter history by prompt text |

## How it works

Claude Code stores each session as a JSONL file under `~/.claude/projects/<encoded-project>/`. Sessions streams these files line by line, so it handles large transcripts without loading everything into memory. Project paths are resolved from the session metadata back to human-readable directory names.

## License

MIT
