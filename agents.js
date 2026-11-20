// Agent onboarding: the block "sessions init" keeps in each agent's global
// instructions file, and the reference "sessions guide" prints.
//
// Agents are who runs this tool. One that was never told about it does not
// reach for it, and one that was only told its name spends its first calls on
// --help. A short block in the file the agent already reads fixes both.

import os from 'node:os';
import path from 'node:path';

const BLOCK_START = '<!-- sessions:start';
const BLOCK_END = '<!-- sessions:end -->';
const BLOCK_PATTERN = /<!-- sessions:start[^\n]*-->[\s\S]*?<!-- sessions:end -->\n?/;

// What an agent needs to know to use the tool well, in as few lines as that
// takes: these lines are loaded into every session of every agent.
export function instructionBlock() {
  return [
    `${BLOCK_START} - managed by "sessions init"; rerun it to update, "sessions init --remove" to delete -->`,
    '## Past sessions: the `sessions` CLI',
    '',
    'Every Claude Code, Codex and Kimi session on this machine can be searched and read with `sessions`: other agents\' sessions, earlier ones of your own, and this one from before a compaction. Look there before asking the user to repeat context or redoing work that was done before. When the user mentions a previous session, "last time", something "we did", or gives a session id, use it.',
    '',
    '- `sessions search "words"` finds messages containing all the words. `"exact phrase"`, `a OR b` and `NOT c` work. Results show one row per session.',
    '- Narrow with `-p <project>`, `--days <n>`, `--source claude|codex|kimi`, `--role user` (what the user said) or `--tools` (commands and file paths that were run).',
    '- `sessions search "words" --session <id>` lists every match in one session. `sessions show <id> --around <N>` reads the conversation around match `#N`; `-C <n>` widens it.',
    '- `sessions show <id> --user-only` lists what the user asked in a session. A full session id pasted by the user works as `<id>`.',
    '- `sessions list -p <project>` and `sessions recap --days 7` show recent sessions.',
    '',
    'Bound output with `-n`, `--around` and `-C` instead of piping to `head`, and keep stderr, where errors are printed. `sessions guide` prints the full reference in one screen.',
    BLOCK_END,
    ''
  ].join('\n');
}

// The one-screen reference. Plain text on purpose: it is read by agents.
export function guideText() {
  return `sessions: search and read every past Claude Code, Codex and Kimi session on this machine.

FIND
  sessions search "deploy staging"        messages containing both words, in any order
  sessions search '"exact phrase"'        those words, in that order
  sessions search "deploy OR release"     either word; NOT word excludes; grep a\\|b and a.*b work
  sessions search "x" -p <project>        only sessions whose project path contains <project>
  sessions search "x" --days 7            only recent sessions (or --since 2026-01-31)
  sessions search "x" --role user         only what the user said (or --role assistant)
  sessions search "x" --tools             also the commands, file paths and arguments of tool calls
  sessions search "x" --source codex      one agent: claude, codex or kimi
  sessions search "x" -n 20               more sessions (default 10); --per-session 3 for more each
  A result row is one session: id, agent, project, who spoke, when, #position, matches in session.
  When nothing matches outright the search loosens (tool calls, then the whole session, then the
  closest messages) and says so on the second line.

READ
  sessions search "x" --session <id>      every match in that session, in the order it was said
  sessions show <id> --around <N>         the conversation around message #N; -C <n> widens it
  sessions show <id> --user-only          what the user asked, in order (--preview: the first few)
  sessions show <id> --no-tools -n 40     the first 40 messages, no tool calls; --offset <n> pages
  sessions export <id> -f md -o out.md    the whole transcript to a file (md, text or json)

BROWSE
  sessions list -p <project> -n 20        recent sessions, newest first (--days, --since, --source)
  sessions recap -p <project> --days 7    recent sessions with the prompts typed in each
  sessions activity --days 7              recent sessions grouped by project
  sessions projects                       every project and how many sessions it has
  sessions history -s "text"              prompts the user typed, across agents

GOOD TO KNOW
  - <id> is the short id from any listing (8 characters, 12 for Codex) or a full session id.
    Qualify it as claude:<id>, codex:<id> or kimi:<id> when two agents share one.
  - All agents' sessions are here, this one included. Subagent transcripts are searched too and
    are marked "(subagent of <id>)"; open one with its own id.
  - Message text and tool-call inputs are searchable. Tool output and model reasoning are not.
  - Bound output with -n, --around and -C rather than piping to head, and keep stderr: errors
    are printed there, and an empty result with stderr discarded hides the reason.
  - Most commands take --json for structured output.
`;
}

// The global instructions file of each supported agent. Environment variables
// that move an agent's home move its file, and the SESSIONS_* overrides used
// for reading transcripts apply here as well.
export function agentTargets(env = process.env, home = os.homedir()) {
  const claudeHome = env.SESSIONS_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = env.SESSIONS_CODEX_DIR || env.CODEX_HOME || path.join(home, '.codex');
  const kimiHome = env.SESSIONS_KIMI_DIR || env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
  return [
    { agent: 'claude', name: 'Claude Code', home: claudeHome, file: path.join(claudeHome, 'CLAUDE.md') },
    {
      agent: 'codex',
      name: 'Codex',
      home: codexHome,
      file: path.join(codexHome, 'AGENTS.md'),
      // Codex reads this one instead of AGENTS.md whenever it is not empty.
      shadowedBy: path.join(codexHome, 'AGENTS.override.md')
    },
    { agent: 'kimi', name: 'Kimi Code', home: kimiHome, file: path.join(kimiHome, 'AGENTS.md') }
  ];
}

// Puts the block into a file's text: replaces the one already there, or adds
// it at the end. existing is null when the file does not exist yet.
export function applyBlock(existing, block = instructionBlock()) {
  const text = existing ?? '';
  if (BLOCK_PATTERN.test(text)) {
    const next = text.replace(BLOCK_PATTERN, () => block);
    return { text: next, change: next === text ? 'unchanged' : 'updated' };
  }
  const gap = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return { text: `${text}${gap}${block}`, change: existing === null ? 'created' : 'added' };
}

export function removeBlock(existing) {
  const text = existing ?? '';
  if (!BLOCK_PATTERN.test(text)) return { text, change: 'absent' };
  const next = text.replace(BLOCK_PATTERN, '').replace(/\n{3,}/g, '\n\n').replace(/\n\n$/, '\n');
  return { text: next.trim() === '' ? '' : next, change: 'removed' };
}

// Whether a file talks about the tool outside the managed block, which
// usually means an older, hand-written note that now repeats it.
export function mentionsOutsideBlock(text) {
  return /\bsessions (search|list|show|recap)\b/.test(String(text || '').replace(BLOCK_PATTERN, ''));
}
