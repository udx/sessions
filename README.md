# Sessions

Search, browse, export, and monitor Claude Code, Codex, and Kimi session transcripts from the command line or a local web dashboard.

Sessions reads the local transcripts stored by Claude Code, Codex, and Kimi Code and provides full-text search, filtering, recap, and export across all three tools. Commands search all sources by default; use `--source claude`, `--source codex`, or `--source kimi` to narrow them.

It is built to be run by the agents themselves: one agent can find what another did last week, pick up a session where it stopped, or check how a problem was solved before asking you again. [Tell your agents about it](#tell-your-agents-about-it) with one command.

Search works out of the box by reading the transcript files. Point it at an Elasticsearch instance and the same queries are ranked, typo-tolerant and answered in a fraction of a second, with labels for classifying sessions. See [Elasticsearch search](#elasticsearch-search).

| Source | Sessions | Prompt history |
|--------|----------|----------------|
| Claude Code | `~/.claude/projects/`, including subagent transcripts | `~/.claude/history.jsonl` |
| Codex | `~/.codex/sessions/` and `~/.codex/archived_sessions/`, plain or compressed | `~/.codex/history.jsonl` |
| Kimi Code | `~/.kimi-code/sessions/` and `~/.kimi/sessions/` (legacy) | `~/.kimi-code/user-history/` and `~/.kimi/user-history/` |

## Installation

```bash
npm install -g @udx/sessions
```

## Tell your agents about it

An agent that has never heard of `sessions` will not use it, and one that only knows the name spends its first calls on `--help`. Add a short note to the instructions each agent already reads:

```bash
sessions init              # Claude Code, Codex and Kimi Code, whichever are installed
sessions init --dry-run    # show what would change
sessions init --agent codex
sessions init --remove     # take the note out again
```

| Agent | File |
|-------|------|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Kimi Code | `~/.kimi-code/AGENTS.md` |

The note is a block of about ten lines between `<!-- sessions:start -->` and `<!-- sessions:end -->`. Everything outside it is left alone, and running `sessions init` again updates it in place. For a project-level file such as a repository's `AGENTS.md`, paste the output of `sessions init --print`.

`sessions guide` prints the whole tool in one screen, written for an agent to read once.

## Commands

### Web dashboard

```bash
sessions --serve
sessions serve --port 4220 --open
sessions serve --active-minutes 30
```

Open `http://127.0.0.1:4220` to browse all active and past sessions in a minimalist light or dark interface. The dashboard shows each session's source, prompt or title, project folder, last activity, model, message counts, size, and seven-day activity histogram. Filter by status, source, project, or search text. Select a title to reveal its full first prompt, additional details, and recent conversation with formatted Markdown links, lists, code, and tables; load earlier messages inline without leaving the list. Raw HTML remains escaped text and unsafe links are blocked. Expanded rows stay open during refreshes. **Copy command** copies the native CLI command (`claude --resume`, `codex resume`, or `kimi --session`) with the correct project directory.

The page refreshes every 60 seconds and on demand. Sessions modified within the last 15 minutes count as active; archived sessions always count as past. Metadata is cached by transcript modification time and size, so refreshes only reread changed sessions. The server binds to localhost by default because session metadata is private. Use `--host` only if you understand the exposure, `--port 0` to choose a free port, and `--open` to launch a browser. Press Ctrl+C to stop the server.

### List sessions

```bash
sessions list
sessions list -p my-project -n 10
sessions list -p my-project --source codex
sessions list --since 2026-01-01 --full
sessions list --subagents
```

Claude subagent transcripts are left out of listings unless you pass `--subagents`. Search always reads them.

### Search transcripts

```bash
sessions search "authentication bug"            # both words, in any order
sessions search '"exact phrase"'                # those words, in that order
sessions search "deploy OR release"             # either word
sessions search "deploy NOT staging"            # exclude a word
sessions search 'login.*timeout'                # grep style: both, in that order
sessions search 'staging\|production'           # grep style: either
sessions search "refactor" -p my-project --days 14
sessions search "docker run" --tools            # also commands, file paths and arguments
```

A query means the same whether or not an index exists. Without one, words match as case-insensitive substrings (`deploy` finds `deployed` and `redeploy`) and sessions are read newest first; with one, word forms and typos match and results are ranked across everything.

```text
5 matches in 2 sessions
a1b2c3d4 [claude] /work/shop-api you 2 hours ago #0 (3 matches in session)
    The checkout page throws a timeout on staging.
e5f6a7b8 [kimi] /work/shop-api kimi yesterday #12 (2 matches in session)
    Release notes drafted: checkout rewrite, faster carts.

Drill in: add --session a1b2c3d4 for every match in that session, or run: sessions show a1b2c3d4 --around 0
```

Each row is one session, so `-n 10` covers ten sessions rather than ten lines from one. `#0` is the position of the message in its session. To get closer:

```bash
sessions search "checkout" --session a1b2c3d4     # every match in that session, in order
sessions search "checkout" --per-session 3        # more matches from each session
sessions show a1b2c3d4 --around 0                 # read the conversation there
```

When nothing matches every term in one message, the search loosens one step at a time and says which step answered: tool calls (commands, file paths, arguments), then the terms spread across one session, then the messages that contain most of them. `--literal` turns all of that off and matches the query as one exact substring.

Other filters: `--role user` or `--role assistant` for who said it, `--tool Bash` for messages that called a tool, `-C 2` to print the neighboring messages, labeled `[you]`, `[claude]`, `[codex]`, or `[kimi]`. Matches inside a Claude subagent's transcript are marked `(subagent of <session>)`.

Without an index the scan stops once it has found `-n` sessions, and says so: `Newest 10 matching sessions (read 37 of 412 sessions, newest first)`. Raise `-n`, or narrow with `-p`, `--days` or `--since`, to go further back.

### Show a session

```bash
sessions show a1b2c3d4
sessions show 019f6b6e4311 --source codex
sessions show codex:019f6b6e4311
sessions show a1b2c3d4 --preview
sessions show a1b2c3d4 --assistant-only
sessions show a1b2c3d4 --no-tools -n 20
sessions show a1b2c3d4 --around 42 -C 5
```

The `--preview` flag shows a compact list of the first few prompts, useful for quickly understanding what a session was about. Combine with `--assistant-only` to preview assistant responses instead.

`--around <position>` opens the conversation at one message and shows `-C` messages on either side (default 3). Positions count every user and assistant message from 0, which is the `#N` that search prints next to each match. The output ends with the commands for the page before and after.

Claude and Kimi short IDs use the first 8 UUID characters. Codex short IDs use the first 12 because its time-ordered UUIDs commonly share their first 8. If an ID exists in multiple sources, qualify it as `claude:<id>`, `codex:<id>`, or `kimi:<id>`. A full ID works too, and so does Kimi's `session_<id>` form.

A Claude subagent transcript opens like any session, by the ID search shows for it. Its header names the session it worked for.

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

## Elasticsearch search

This part is optional. Until an Elasticsearch URL is configured, Sessions never looks for one: search reads the transcript files, and nothing else changes.

Reading every transcript takes longer as history grows, and without an index there is nothing to rank results with, no tolerance for a typo, and no count of everything that matched. With an Elasticsearch URL configured, `sessions search` answers the same queries from an index instead.

### Setup

Transcripts hold private material, so start with an instance on your own machine:

```bash
docker run -d --name sessions-es --restart unless-stopped -p 127.0.0.1:9220:9200 \
  -v sessions-es:/usr/share/elasticsearch/data \
  -e discovery.type=single-node -e xpack.security.enabled=false \
  -e ES_JAVA_OPTS="-Xms1g -Xmx1g" elasticsearch:8.19.25
```

The named volume keeps the index when the container is removed, and the restart policy brings it back whenever Docker starts.

Then tell Sessions where it is, in `~/.sessions/config.yaml`:

```yaml
elasticsearch:
  url: http://127.0.0.1:9220
  index: sessions        # optional, this is the default
  auto_sync: 10          # optional: minutes before a search refreshes the index
  auto_sync_max_mb: 256  # optional: the most a search will index on its own
search:
  backend: auto          # auto (default), elasticsearch, or local
```

or with `export SESSIONS_ES_URL=http://127.0.0.1:9220`. Build the index once:

```bash
sessions sync
```

From then on `sessions search` uses it. If Elasticsearch is unreachable or nothing is indexed, search reads the files instead and says so in the first line of the results; the query, the options and the shape of the output stay the same. `--local` forces that, and `search.backend: elasticsearch` turns the fallback into an error.

Sync refuses any host that is not this machine unless you pass `--allow-remote` or set `elasticsearch.allow_remote: true`. The generic `ELASTICSEARCH_URL` variable is never read, so a shell that points it at a shared cluster cannot send transcripts there by accident.

### Keeping the index current

```bash
sessions sync                      # re-read only transcripts that changed
sessions sync --days 7             # limit the run to recent sessions
sessions sync --status             # what is indexed, and what changed since
sessions sync --rebuild            # write a new index and swap it in
sessions sync --prune              # drop sessions whose transcript is gone
sessions sync --drop               # delete the index
```

Sync is incremental. It compares each transcript's size and modification time with what was indexed, re-reads the ones that changed, and merges its own fields into the existing documents. A typical run takes a second or two. It records its progress as it goes, so a run that is interrupted keeps the sessions it finished and the next one carries on from there.

With `auto_sync` set, a search does this first whenever the last sync is older than that many minutes. When more than `auto_sync_max_mb` of transcript is waiting, the search answers from the index as it is and ends with what is waiting, for example `42 sessions (1.3 GB) not indexed yet, run "sessions sync"`.

Search reflects the last sync, and every result ends with how long ago that was.

The index is named `<index>-YYYYMMDD-HHMMSS` behind the `<index>` alias. `--rebuild` writes a new one and swaps the alias when it is complete, so searches keep working throughout; it happens automatically when a new version of Sessions changes the index format. Sessions whose transcript was deleted stay searchable until you `--prune`.

### What the index adds

The [query language](#search-transcripts) is the same. On top of it:

- Words match in any form (`deploy` finds `deployed` and `deployment`) and identifiers match across naming styles (`streamsessionmessages`, `stream_session_messages`, and `session messages` all find `streamSessionMessages`).
- Results are ranked by relevance, with recent messages and things you typed counting more; `--sort recent` orders by time instead.
- More steps of loosening when nothing matches outright: words starting with a term, the literal substring, tool calls, the terms spread across one session, similar spellings, and finally most of the terms.
- Every result counts all matches, and ends with where and when the rest are, which names the values you can filter on:

```text
1,001 matches in 120 sessions (showing 2)
...
Projects: www.example.com 24, shop-api 15, infra 13
When: past day 2, past week 6, past month 20, older 92
Sources: claude 81, kimi 37, codex 2
Drill in: add --session a1b2c3d4 for every match in that session, or run: sessions show a1b2c3d4 --around 360
Elasticsearch index synced 2 minutes ago
```

### Labels

Labels are free-form classification stored on the indexed documents: a client, a topic, a sensitivity level, whatever helps you slice your history.

```bash
sessions label a1b2c3d4 client=acme topic=billing,invoices
sessions label a1b2c3d4                     # show
sessions label a1b2c3d4 --remove topic
sessions label a1b2c3d4 --message 42 kind=decision
sessions labels                             # every key and value in use
sessions search "refund" --label client=acme
```

A label on a session applies to all of its messages when filtering; `--message` labels a single one. Values are exact strings, matched without regard to case, and a comma makes a list.

Sync never writes labels, so they survive every sync and every rebuild. The same holds for anything else an agent or script adds to a document through the Elasticsearch API: sync merges only its own fields. Two namespaces are indexed, and carried across a rebuild: `labels.*` for exact values and `notes.*` for free text. Other added fields are kept across normal syncs but are not indexed and do not cross a rebuild.

Labels live only in Elasticsearch. `--drop`, or removing the container, removes them.

## Options

Browsing commands support `--json` for machine-readable output; `export` uses `--format json`. Session-bearing JSON objects include a `source` field.

| Option | Commands | Description |
|--------|----------|-------------|
| `--source <source>` | list, search, show, projects, export, history, recap, activity, sync, label | Search `all`, `claude`, `codex`, or `kimi` sessions (default `all`) |
| `--agent <name>` | init | Only this agent: `claude`, `codex`, or `kimi` (repeatable) |
| `--print` | init | Print the note instead of writing it |
| `--dry-run` | init, sync | Show what would change without writing |
| `--remove` | init | Remove the note from the agents' instructions |
| `--subagents` | list | Include Claude subagent transcripts |
| `--serve` | top level | Start the web dashboard (alias for `serve`) |
| `--host <host>` | serve | Host to bind (default `127.0.0.1`) |
| `-p, --port <port>` | serve | Port to listen on (default `4220`; `0` chooses a free port) |
| `--active-minutes <minutes>` | serve | Active window after the last transcript update (default `15`) |
| `--open` | serve | Open the dashboard in your default browser |
| `-p, --project <path>` | list, search, history, recap, activity | Filter by project path (substring match) |
| `-n, --limit <n>` | list, search, show, history | Max results to display; for search, sessions |
| `--since <date>` | list, search | Only sessions modified after this date |
| `--days <n>` | list, search, recap, activity | Sessions from last N days |
| `--full` | list | Include full message counts (slower) |
| `-C, --context <n>` | search, show | Surrounding conversation messages to show (with `show`, around `--around`) |
| `--role <role>` | search | Only messages from `user` or `assistant` |
| `--local` | search | Read the files even when Elasticsearch is configured |
| `--session <id>` | search | Every match inside one session, in order |
| `--per-session <n>` | search | Matches shown per session (default 1) |
| `--tools` | search | Also search tool calls |
| `--tool <name>` | search | Only messages that called this tool |
| `--literal` | search | Match the query as one exact substring |
| `--sort <order>` | search | `relevance` (default) or `recent`; without an index, sessions come newest first either way |
| `--label <key=value>` | search | Elasticsearch: only labeled sessions or messages (repeatable) |
| `--around <position>` | show | Open the conversation at a message position |
| `--es-url <url>` | sync | Elasticsearch URL for this run |
| `--index <name>` | sync | Alias and index prefix (default `sessions`) |
| `--rebuild` | sync | Write a new index and swap it in |
| `--keep <n>` | sync | Indices to keep after a rebuild (default 1) |
| `--prune` | sync | Remove sessions whose transcript is no longer on disk |
| `--status` | sync | Show the index and local changes since the last sync |
| `--drop` | sync | Delete the index, including its labels |
| `--allow-remote` | sync | Allow an Elasticsearch host other than this machine |
| `--remove <key>` | label | Remove a label (repeatable) |
| `--message <position>` | label | Label one message instead of the session |
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

Search returns one object per match, best session first: `sessionId`, `shortId`, `source`, `project`, `timestamp`, `type` (`user` or `assistant`), `snippets`, `matchesInSession`, `seq` (the message position, for `show --around` and `label --message`), `tools`, and `matchMode`, which says how the query was matched: `smart`, `literal`, `tools`, `session`, or `partial`, plus `prefix` and `fuzzy` with an index. `contextMessages` holds `type`, `text`, and `position` when using `-C`. `injected: true` marks text that a tool recorded under the user role, such as a task notification, and `subagent: true` with `parentSessionId` marks a match in a subagent's transcript.

Results from an index add `score`, and `sessionLabels` and `labels` when something is labeled.

## Configuration

Sessions respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Tests and custom integrations can override the roots directly with `SESSIONS_CLAUDE_DIR`, `SESSIONS_CODEX_DIR`, and `SESSIONS_KIMI_DIR` (the Kimi override takes a single root; by default both `~/.kimi-code` and the legacy `~/.kimi` are scanned). The dashboard is local-only and does not require API keys or send session data to external services.

Elasticsearch settings come from command-line flags, then environment variables, then `~/.sessions/config.yaml` (`SESSIONS_CONFIG` points at a different file):

| Environment variable | Config key | Meaning |
|----------------------|------------|---------|
| `SESSIONS_ES_URL` | `elasticsearch.url` | Elasticsearch URL; setting it turns the backend on |
| `SESSIONS_ES_INDEX` | `elasticsearch.index` | Alias and index prefix (default `sessions`) |
| `SESSIONS_ES_API_KEY` | `elasticsearch.api_key` | API key, for a secured cluster |
| `SESSIONS_ES_USERNAME`, `SESSIONS_ES_PASSWORD` | `elasticsearch.username`, `elasticsearch.password` | Basic authentication |
| `SESSIONS_ES_ALLOW_REMOTE` | `elasticsearch.allow_remote` | Permit a host other than this machine |
| `SESSIONS_ES_AUTO_SYNC` | `elasticsearch.auto_sync` | Minutes before a search refreshes the index; `0` is off (default) |
| `SESSIONS_ES_AUTO_SYNC_MAX_MB` | `elasticsearch.auto_sync_max_mb` | The most transcript, in megabytes, a search indexes on its own (default `256`) |
| | `elasticsearch.keep` | Indices to keep after a rebuild (default 1) |
| `SESSIONS_SEARCH_BACKEND` | `search.backend` | `auto` (default), `elasticsearch`, or `local` |

Developed and tested against Elasticsearch 8.19, using only features available since 8.6. Requests are plain REST calls, so no client library is installed.

Codex CLI and desktop app sessions are both supported. Codex appends active sessions under date-based directories and compresses finished ones to `.jsonl.zst` after a few days. Sessions scans those directories recursively and reads both forms. Compressed rollouts need Node 22.15 or newer, or the `zstd` command on your path; without either they are skipped with a notice. It filters internal/developer messages and collapses Codex's adjacent event/response duplicates. Desktop Page context and plugin recommendations are excluded from prompts and search; actual user replies are retained. For sessions absent from `history.jsonl` (including desktop chats), `history` reads user prompts from the transcripts. Existing global history remains authoritative for sessions it contains.

Claude Code keeps what a subagent did in its own transcript, under `<project>/<session-id>/subagents/`, including the agents a workflow runs. Search reads those, `show` and `export` open them by ID, and `sync` indexes them; listings leave them out unless asked. What a subagent was told is shown as coming from its parent agent, not from you.

Claude Code deletes transcripts after 30 days unless `cleanupPeriodDays` in `~/.claude/settings.json` says otherwise, and a deleted transcript can no longer be read. An Elasticsearch index keeps what it has already indexed until you run `sessions sync --prune`.

Kimi Code sessions come in two on-disk generations, and both are read. Modern sessions live under `~/.kimi-code/sessions/wd_<slug>_<hash>/session_<uuid>/`; the project path and title come from `state.json` and the transcript is reconstructed from the main agent's event-sourced `agents/main/wire.jsonl` (user inputs from `context.append_message` events with `origin.kind: user`, assistant output grouped per step, model from `llm.request`). Legacy sessions under `~/.kimi/sessions/<md5(workdir)>/<uuid>/` are read from the ready-made `context.jsonl`, with the project path resolved through `kimi.json`'s `work_dirs` or, failing that, the session's system prompt. Kimi's `user-history` files carry no timestamps, so those history entries sort after timestamped ones; thinking blocks, tool results, and injected system reminders are never shown or searched.

## Changelog

### 1.11.0
- Search means the same with or without Elasticsearch. The file scan now understands the full query language (words in any order, `"phrases"`, `OR`, `NOT`, grep-style `a\|b` and `a.*b`), shows one row per session with its position for `show --around`, and loosens step by step when nothing matches outright. `--session`, `--per-session`, `--tools`, `--tool` and `--literal` no longer need an index. A multi-word query used to be matched as one exact phrase without an index; `--literal` keeps that
- When a configured index cannot be used, the reason is the first line of the results instead of a line on stderr
- Added `sessions init`, which keeps a short note about this tool in the global instructions of Claude Code, Codex and Kimi Code, and `sessions guide`, a one-screen reference written for agents. `--help` now ends with the most used commands
- Compressed Codex rollouts (`.jsonl.zst`) are read, which is most of a Codex history older than a few days. Needs Node 22.15 or newer, or the `zstd` command
- Claude subagent transcripts are searched, shown, exported and indexed, and marked with the session they worked for. `list --subagents` includes them
- Transcripts are split on newlines only. A record containing U+2028 or U+2029 was dropped before
- A transcript that cannot be read to the end, such as a damaged archive, is read as far as it goes and named once on stderr, instead of stopping the command
- Codex records that never become messages (tool output, token counts, compaction records) are skipped unparsed, and a forked rollout is identified from the head of its file instead of by reading all of it
- Sync records its progress as it goes, so an interrupted run resumes instead of starting over. A search with `auto_sync` leaves a backlog larger than `auto_sync_max_mb` (default 256) to `sessions sync` and says what is waiting
- The suggested Docker command keeps the index in a named volume and restarts with Docker
- `sessions list` with nothing to show says where it looked, and `session_<id>` is accepted wherever a session ID is

### 1.10.0
- Added optional Elasticsearch-backed search, enabled by `SESSIONS_ES_URL` or `~/.sessions/config.yaml`, with automatic fallback to the file scan. Nothing changes until one of those is set
- Prompts typed while Claude Code is still working are now read as user messages by every command; they were skipped before, so message counts and positions in those sessions grow
- Added `sessions sync`: incremental indexing that merges into existing documents, plus `--rebuild`, `--prune`, `--status`, `--drop`, and `--dry-run`
- Search with Elasticsearch ranks by relevance, matches word forms and identifier parts, understands phrases, `OR`, `NOT`, and grep-style `a.*b` and `a\|b`, and loosens step by step (prefix, substring, tool calls, across a session, typos) when nothing matches outright
- Results show one match per session with project, time, and source facets; `--session` and `show --around` drill in
- Added `--tools` and `--tool` to search the commands, paths, and arguments of tool calls
- Added labels: `sessions label`, `sessions labels`, and `search --label`; labels survive syncs and rebuilds
- Added `--role` to search, for both backends
- Sync refuses non-local Elasticsearch hosts unless allowed, and never reads `ELASTICSEARCH_URL`

### 1.9.1
- Render common Markdown in first prompts and recent conversation, including links, lists, headings, code, and tables
- Keep raw HTML escaped, block unsafe links, and avoid loading external images
- Render bare URLs without recursive links and copy canonical Kimi `session_` IDs for native resume
- Added regression and browser checks for formatted output, XSS safety, and mobile layout

### 1.9.0
- Added expandable session details with full first prompts and refresh-safe open state
- Added paginated recent-conversation previews with tools-used summaries and human-readable titles
- Refined the flat list hierarchy, neutral histograms, progressive filters, and mobile layouts

### 1.8.0
- Redesigned the dashboard as a responsive minimalist app with light and dark appearances
- Added per-session seven-day activity histograms from normalized message timestamps

### 1.7.0
- Added `sessions serve` and `sessions --serve` with a localhost dashboard for all active and past sessions
- Added 60-second refreshes, metadata caching, status/source/project/search filters, message counts, and native resume-command copying
- Added Kimi `state.json` titles, creation times, archive state, and support for current `cwd` project paths alongside legacy `workDir`

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
