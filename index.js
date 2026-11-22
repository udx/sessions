#!/usr/bin/env node

import { InvalidArgumentError, program } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, existsSync } from 'fs';
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import zlib from 'zlib';
import os from 'os';
import { fileURLToPath } from 'url';
import { displayUrl, isLoopbackUrl, isValidIndexName, loadConfig } from './lib/config.js';
import { HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE } from './lib/query.js';
import { desktopDataDirs, desktopNote, findCoworkSessions, readCodeRecords } from './lib/desktop.js';
import { createFrameWatch } from './lib/zstd-frames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const CLAUDE_DIR = process.env.SESSIONS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CODEX_DIR = process.env.SESSIONS_CODEX_DIR || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CLAUDE_HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const CODEX_ARCHIVED_SESSIONS_DIR = path.join(CODEX_DIR, 'archived_sessions');
const CODEX_HISTORY_FILE = path.join(CODEX_DIR, 'history.jsonl');
const KIMI_ROOTS = process.env.SESSIONS_KIMI_DIR
  ? [process.env.SESSIONS_KIMI_DIR]
  : [path.join(os.homedir(), '.kimi-code'), path.join(os.homedir(), '.kimi')];
const VALID_SOURCES = new Set(['all', 'claude', 'codex', 'kimi']);
const c = chalk;

function parseSource(value) {
  const source = String(value || 'all').toLowerCase();
  if (!VALID_SOURCES.has(source)) {
    throw new InvalidArgumentError('source must be one of: all, claude, codex, kimi');
  }
  return source;
}

function sourceTag(source) {
  if (source === 'codex') return c.magenta('[codex]');
  if (source === 'kimi') return c.whiteBright('[kimi]');
  return c.blue('[claude]');
}

function speakerName(source) {
  if (source === 'codex') return 'Codex';
  if (source === 'kimi') return 'Kimi';
  return 'Claude';
}

function sessionKey(session) {
  return `${session.source}:${session.sessionId}`;
}

function daysToSinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatRelativeTime(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days > 7) return date.toISOString().split('T')[0];
  if (days > 1) return `${days} days ago`;
  if (days === 1) return 'yesterday';
  if (hours > 1) return `${hours} hours ago`;
  if (hours === 1) return '1 hour ago';
  if (minutes > 1) return `${minutes} minutes ago`;
  if (minutes === 1) return '1 minute ago';
  return 'just now';
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function hasTextContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(block => block && block.type === 'text' && block.text && block.text.trim());
  }
  return false;
}

function truncate(text, maxLength = 80) {
  const oneLine = text.replace(/\n+/g, ' ').replace(/[#*`_~>|\-]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 1) + '\u2026';
}

function cleanSnippet(text) {
  let cleaned = text;
  cleaned = cleaned.replace(/```[\w]*\n[\s\S]*?\n```/g, '[code block]');
  cleaned = cleaned.replace(/^\|.*\|$/gm, '');
  cleaned = cleaned.replace(/^[\s]*[-*] /gm, '  - ');
  cleaned = cleaned.replace(/#{1,6}\s+/g, '');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function wrapText(text, width, indent = 2) {
  if (!text) return '';
  const prefix = ' '.repeat(indent);
  const lines = text.split('\n');
  const wrapped = [];
  for (const line of lines) {
    if (line.length <= width - indent) {
      wrapped.push(prefix + line);
    } else {
      let remaining = line;
      while (remaining.length > width - indent) {
        let breakAt = remaining.lastIndexOf(' ', width - indent);
        if (breakAt <= 0) breakAt = width - indent;
        wrapped.push(prefix + remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) wrapped.push(prefix + remaining);
    }
  }
  return wrapped.join('\n');
}

// Codex compresses a finished rollout to .jsonl.zst. Node reads Zstandard on
// its own from 22.15; before that the zstd command does it, when installed.
// SESSIONS_ZSTD_READER (zlib, command, or none) pins the choice for tests.
let zstdReader;
function zstdSupport() {
  if (zstdReader !== undefined) return zstdReader;
  const forced = String(process.env.SESSIONS_ZSTD_READER || '').toLowerCase();
  const builtIn = typeof zlib.createZstdDecompress === 'function';
  if (forced === 'none') zstdReader = null;
  else if (builtIn && forced !== 'command') zstdReader = 'zlib';
  else zstdReader = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0 ? 'command' : null;
  return zstdReader;
}

// Some Node versions end a cut-off archive without an error. Whether this one
// does is found out once, by handing the decoder nine bytes of a frame.
let zstdQuiet;
function zstdEndsQuietly() {
  if (zstdQuiet === undefined) {
    try {
      zlib.zstdDecompressSync(Buffer.from('28b52ffd2001090000', 'hex'));
      zstdQuiet = true;
    } catch {
      zstdQuiet = false;
    }
  }
  return zstdQuiet;
}

const ZSTD_REQUIREMENT = 'reading .jsonl.zst needs Node 22.15 or newer, or the zstd command';

// Opens a transcript as a stream of bytes, decompressing when it has to.
function openTranscript(filePath) {
  if (!filePath.endsWith('.zst')) {
    const stream = createReadStream(filePath);
    return { input: stream, dispose: () => stream.destroy() };
  }
  const reader = zstdSupport();
  if (reader === 'zlib') {
    const source = createReadStream(filePath, { highWaterMark: 1 << 20 });
    const decoder = zlib.createZstdDecompress({ chunkSize: 1 << 20 });
    source.on('error', error => decoder.destroy(error));
    source.pipe(decoder);
    const opened = { input: decoder, dispose: () => { source.destroy(); decoder.destroy(); } };
    if (zstdEndsQuietly()) {
      // The decoder will not say the file was cut off, so its frames are
      // followed on the way in.
      const frames = createFrameWatch();
      source.on('data', chunk => frames.write(chunk));
      opened.problem = async () => (frames.cutShort() ? new Error('unexpected end of file') : null);
    }
    return opened;
  }
  if (reader === 'command') {
    const child = spawn('zstd', ['-dc', '--', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let complaint = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => { if (complaint.length < 2000) complaint += chunk; });
    child.on('error', error => child.stdout.destroy(error));
    const exited = new Promise(resolve => child.on('close', resolve));
    return {
      input: child.stdout,
      dispose: () => { child.stdout.destroy(); child.kill(); },
      // The command's output just ends when the archive is damaged, so its
      // exit status is what says the file was not read to the end.
      problem: async () => {
        const code = await exited;
        if (code === 0) return null;
        const said = complaint.trim().split('\n').pop().replace(/^zstd: /, '').replace(`${filePath}: `, '');
        return new Error(said || `zstd exited with status ${code}`);
      }
    };
  }
  throw new Error(ZSTD_REQUIREMENT);
}

const LINE_HEAD_BYTES = 160;

// The first bytes of a line that is still being collected, as text.
function lineHead(parts) {
  if (parts.length === 1) return parts[0].toString('latin1', 0, LINE_HEAD_BYTES);
  let head = '';
  for (const part of parts) {
    head += part.toString('latin1', 0, LINE_HEAD_BYTES - head.length);
    if (head.length >= LINE_HEAD_BYTES) break;
  }
  return head;
}

// Yields the lines of a JSONL byte stream as strings.
//
// Lines end at "\n" and nowhere else. readline also breaks on U+2028 and
// U+2029, which a JSON string may contain as they are, and so loses every
// record that holds one.
//
// isUnused, when given, sees the first bytes of each line and returns true
// for a line that is not worth reading. Such a line is never turned into a
// string, which matters when most of a file is multi-megabyte tool output.
async function* jsonLines(input, isUnused = null) {
  let parts = [];
  let length = 0;
  let judged = isUnused === null;
  let skipping = false;

  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (!skipping) {
        if (end > offset) {
          parts.push(chunk.subarray(offset, end));
          length += end - offset;
        }
        if (!judged && (length >= LINE_HEAD_BYTES || newline !== -1)) {
          judged = true;
          if (length > 0 && isUnused(lineHead(parts))) skipping = true;
        }
      }
      if (newline === -1) break;
      if (!skipping && length > 0) {
        yield (parts.length === 1 ? parts[0] : Buffer.concat(parts, length)).toString('utf8');
      }
      parts = [];
      length = 0;
      judged = isUnused === null;
      skipping = false;
      offset = newline + 1;
    }
    if (skipping && parts.length > 0) {
      parts = [];
      length = 0;
    }
  }
  if (!skipping && length > 0) {
    yield (parts.length === 1 ? parts[0] : Buffer.concat(parts, length)).toString('utf8');
  }
}

const unreadableWarned = new Set();

// Reads a JSONL transcript record by record until the callback returns true.
// A stream that fails part way (a damaged archive, a file removed mid-read)
// ends the read there: what came before it is kept, and the file is named
// once on stderr, so one bad transcript never stops a command.
async function streamLines(filePath, callback, isUnused = null) {
  let opened;
  try {
    opened = openTranscript(filePath);
  } catch (error) {
    warnUnreadable(filePath, error);
    return;
  }
  let stopped = false;
  try {
    for await (const line of jsonLines(opened.input, isUnused)) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const stop = callback(data);
        if (stop === true) {
          stopped = true;
          break;
        }
      } catch {}
    }
    // Stopping early leaves the rest unread on purpose; only a read that ran
    // to the end can have been cut short.
    const problem = !stopped && opened.problem ? await opened.problem() : null;
    if (problem) warnUnreadable(filePath, problem);
  } catch (error) {
    warnUnreadable(filePath, error);
  } finally {
    opened.dispose();
  }
}

function warnUnreadable(filePath, error) {
  if (unreadableWarned.has(filePath)) return;
  unreadableWarned.add(filePath);
  console.error(c.yellow(`Could not read all of ${filePath}: ${error.message}`));
}

// Most of a Codex rollout is tool output, screenshots and bookkeeping that
// never becomes a message, and parsing it is where reading one spends its
// time. Such a record is recognized from the start of its line and skipped
// unparsed. A line that does not start the expected way is parsed as before.
const CODEX_LINE_HEAD = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const CODEX_UNUSED_RECORDS = new Set(['compacted', 'token_usage_record', 'world_state', 'inter_agent_communication_metadata']);
const CODEX_USED_ITEMS = new Set(['message', 'function_call', 'custom_tool_call']);
const CODEX_USED_EVENTS = new Set(['user_message', 'agent_message']);

function isUnusedCodexLine(lineStart) {
  const head = CODEX_LINE_HEAD.exec(lineStart);
  if (!head) return false;
  const [, type, inner] = head;
  if (CODEX_UNUSED_RECORDS.has(type)) return true;
  if (!inner) return false;
  if (type === 'response_item') return !CODEX_USED_ITEMS.has(inner);
  if (type === 'event_msg') return !CODEX_USED_EVENTS.has(inner);
  return false;
}

async function resolveClaudeProjectPath(projectDir) {
  const files = await fs.readdir(projectDir);
  const firstSession = files.find(f => f.endsWith('.jsonl'));
  if (!firstSession) return null;

  let cwd = null;
  await streamLines(path.join(projectDir, firstSession), (data) => {
    if (data.cwd) { cwd = data.cwd; return true; }
  });
  return cwd;
}

// Places sessions are kept in that are there and could not be looked at.
// Sessions in them are missing from whatever a command answers, so each is
// named once on stderr, and a sync does not prune while there is one: a
// session that could not be seen is not a session that was deleted.
const unreadableFolders = new Map();
function noteUnreadableFolder(target, reason) {
  if (unreadableFolders.has(target)) return;
  unreadableFolders.set(target, reason);
  console.error(c.yellow(`Could not read ${tildePath(target)} (${reason}); sessions there are left out.`));
}
const isAbsent = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

// stat and readdir for discovery. "Not there" is an answer and says nothing.
// Anything else that goes wrong is noted (see above) and reads as absent.
async function statNoting(target) {
  try {
    return await fs.stat(target);
  } catch (error) {
    if (!isAbsent(error)) noteUnreadableFolder(target, error.code || error.message);
    return null;
  }
}
async function listNoting(dir, options) {
  try {
    return await fs.readdir(dir, options);
  } catch (error) {
    if (!isAbsent(error)) noteUnreadableFolder(dir, error.code || error.message);
    return [];
  }
}

// Lists a folder Claude sessions are read from. In Claude Code's own folders
// a failed listing stops the command, as it always has. A folder of the
// desktop app that cannot be listed is noted and skipped.
function listSessionFolder(dir, ofApp) {
  return ofApp ? listNoting(dir) : fs.readdir(dir);
}

// What the Claude desktop app knows about its sessions: a record for each
// Code tab session, keyed by transcript, and the storage folder of each
// Cowork session. Kept for a few seconds, so one command reads it once and
// the dashboard, which runs for hours, still sees what the app does next.
const DESKTOP_STATE_MS = 5_000;
let desktopState = null;
async function desktopSessions() {
  if (desktopState && Date.now() - desktopState.readAt < DESKTOP_STATE_MS) return desktopState;
  const code = new Map();
  const storage = new Map();
  let visible = false;
  for (const dataDir of desktopDataDirs()) {
    if (!existsSync(dataDir)) continue;
    visible = true;
    const problems = [];
    for (const [transcriptId, record] of await readCodeRecords(dataDir, problems)) {
      const known = code.get(transcriptId);
      if (!known || (record.lastActivityAt || 0) >= (known.lastActivityAt || 0)) code.set(transcriptId, record);
    }
    // On Windows the app has two places for its data and can move between
    // them. A session kept in both is one session: the copy last active.
    for (const found of await findCoworkSessions(dataDir, problems)) {
      const key = path.basename(found.storageDir);
      const known = storage.get(key);
      if (!known || (found.record.lastActivityAt || 0) > (known.record.lastActivityAt || 0)) storage.set(key, found);
    }
    for (const problem of problems) noteUnreadableFolder(problem.path, problem.reason);
  }
  // `visible`: whether this run can see the app's data at all. One that
  // cannot has nothing to say about which sessions the app knows.
  desktopState = { readAt: Date.now(), code, cowork: [...storage.values()], visible };
  return desktopState;
}

// The project folders under one "projects" directory. `desktop` is the
// Cowork session that directory belongs to, when it is one's private copy.
async function claudeProjectsIn(projectsDir, desktop = null) {
  const projects = [];
  const ofApp = desktop !== null;
  const entries = await listSessionFolder(projectsDir, ofApp);
  for (const entry of entries) {
    const projectDir = path.join(projectsDir, entry);
    const stat = await statNoting(projectDir);
    if (!stat || !stat.isDirectory()) continue;

    const files = await listSessionFolder(projectDir, ofApp);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
    if (sessionFiles.length === 0) continue;

    let totalSize = 0;
    for (const file of sessionFiles) {
      const s = await statNoting(path.join(projectDir, file));
      if (s) totalSize += s.size;
    }

    // A Cowork session works inside a sandbox, so the folder the person gave
    // it says more than the path it ran in.
    const decoded = desktop?.folders[0] || await resolveClaudeProjectPath(projectDir) || desktop?.cwd || entry;

    projects.push({
      encoded: entry,
      path: decoded,
      source: 'claude',
      sessionCount: sessionFiles.length,
      totalSize,
      dir: projectDir,
      desktop
    });
  }
  return projects;
}

// Projects of the Claude Code CLI, then those inside the desktop app's
// Cowork sessions, which keep their transcripts in folders of their own.
async function getClaudeProjects() {
  const projects = existsSync(PROJECTS_DIR) ? await claudeProjectsIn(PROJECTS_DIR) : [];
  for (const cowork of (await desktopSessions()).cowork) {
    const inside = await claudeProjectsIn(cowork.projectsDir, cowork.record);
    // A record that does not say which transcript is its own can only speak
    // for a storage folder that holds a single one.
    const transcripts = inside.reduce((sum, project) => sum + project.sessionCount, 0);
    for (const project of inside) project.desktopSole = transcripts === 1;
    projects.push(...inside);
  }
  return projects.sort((a, b) => a.path.localeCompare(b.path));
}

// The name Claude Code holds for a session. /rename and the desktop app
// write it into the transcript as a "custom-title" record, and Claude Code
// keeps appending the current one so that it stays within the last 64 KB of
// the file, which is where its own session list looks for it. It also keeps
// the name in a small file beside the transcript, and its list falls back to
// that and then to the first 64 KB. This reads the same three places in the
// same order, so a session has here the name it has there, and knowing it
// never takes reading a whole transcript.
const NAME_WINDOW = 64 * 1024;
const NAME_RECORD = Buffer.from('"custom-title"');

// The latest name among the complete records in a stretch of a transcript.
function latestName(buffer, length) {
  let before = length;
  while (before > 0) {
    const at = buffer.lastIndexOf(NAME_RECORD, before - 1);
    if (at === -1) return null;
    const lineStart = buffer.lastIndexOf(10, at) + 1;
    const newline = buffer.indexOf(10, at);
    const lineEnd = newline === -1 || newline > length ? length : newline;
    try {
      const record = JSON.parse(buffer.toString('utf8', lineStart, lineEnd));
      if (record?.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) {
        return record.customTitle.trim();
      }
    } catch {}
    before = lineStart;
  }
  return null;
}

async function claudeSessionName(filePath, size) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const length = Math.min(size, NAME_WINDOW);
    const stretch = Buffer.allocUnsafe(length);
    const end = await handle.read(stretch, 0, length, size - length);
    const atEnd = latestName(stretch, end.bytesRead);
    if (atEnd) return atEnd;

    try {
      const beside = path.join(filePath.slice(0, -'.jsonl'.length), 'custom-title.json');
      const kept = JSON.parse(await fs.readFile(beside, 'utf8'));
      if (typeof kept?.customTitle === 'string' && kept.customTitle.trim()) return kept.customTitle.trim();
    } catch {}

    // A file no longer than the window has been read whole already.
    if (size <= NAME_WINDOW) return null;
    const start = await handle.read(stretch, 0, length, 0);
    return latestName(stretch, start.bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

function makeShortId(source, sessionId) {
  const compact = String(sessionId || '').replace(/-/g, '');
  return source === 'codex' ? compact.slice(0, 12) : compact.slice(0, 8);
}

// Subagent transcripts sit beside the session that spawned them:
//   <project>/<session-id>/subagents/agent-<id>.jsonl
//   <project>/<session-id>/subagents/workflows/<workflow-id>/agent-<id>.jsonl
// each with an optional agent-<id>.meta.json naming its type and its task.
// They are searchable and can be shown, but stay out of session listings.
async function getClaudeSubagentFiles(projectDir, project) {
  const found = [];
  const entries = await listNoting(projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pending = [path.join(projectDir, entry.name, 'subagents')];
    while (pending.length > 0) {
      const dir = pending.pop();
      const items = await listNoting(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          pending.push(fullPath);
          continue;
        }
        const match = item.isFile() ? item.name.match(/^agent-([A-Za-z0-9_-]+)\.jsonl$/) : null;
        if (!match) continue;
        const stat = await statNoting(fullPath);
        if (!stat) continue;
        let meta = {};
        try {
          meta = JSON.parse(await fs.readFile(fullPath.replace(/\.jsonl$/, '.meta.json'), 'utf8')) || {};
        } catch {}
        found.push({
          sessionId: match[1],
          shortId: makeShortId('claude', match[1]),
          source: 'claude',
          project: project.path,
          projectEncoded: project.encoded,
          filePath: fullPath,
          size: stat.size,
          modifiedAt: stat.mtime,
          subagent: true,
          parentSessionId: entry.name,
          agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
          title: typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : null
        });
      }
    }
  }
  return found;
}

async function getClaudeSessionFiles(projectFilter = null, { subagents = false } = {}) {
  const projects = await getClaudeProjects();
  const codeRecords = (await desktopSessions()).code;
  const sessions = [];
  const agents = new Map();

  for (const project of projects) {
    if (projectFilter) {
      const pf = projectFilter.toLowerCase();
      const matchesDecoded = project.path.toLowerCase().includes(pf);
      const matchesEncoded = project.encoded.toLowerCase().includes(pf);
      if (!matchesDecoded && !matchesEncoded) continue;
    }

    const projectDir = project.dir;
    const files = await listSessionFolder(projectDir, Boolean(project.desktop));
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const file of sessionFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      const stat = await statNoting(filePath);
      if (!stat) continue;

      const session = {
        sessionId,
        shortId: makeShortId('claude', sessionId),
        source: 'claude',
        project: project.path,
        projectEncoded: project.encoded,
        filePath,
        size: stat.size,
        modifiedAt: stat.mtime
      };
      // A session of the desktop app carries what the app knows about it:
      // which tab it belongs to and whether it is archived.
      const desktop = project.desktop || codeRecords.get(sessionId);
      if (desktop) {
        session.app = 'desktop';
        session.desktopKind = desktop.kind;
        if (desktop.archived) session.archived = true;
      }
      // Its name is the one the app shows. A Cowork record names only the
      // session's own transcript, not every transcript in its storage folder.
      // Failing that, the name Claude Code holds for the session.
      const own = !project.desktop
        ? desktop
        : desktop.transcriptId ? (desktop.transcriptId === sessionId ? desktop : null) : (project.desktopSole ? desktop : null);
      const name = own?.title || await claudeSessionName(filePath, stat.size);
      if (name) {
        session.title = name;
        session.named = true;
      }
      sessions.push(session);
    }

    if (subagents) {
      // A resumed session can carry a copy of a subagent's transcript; the
      // newer copy stands for the agent.
      for (const agent of await getClaudeSubagentFiles(projectDir, project)) {
        const existing = agents.get(agent.sessionId);
        if (!existing || agent.modifiedAt > existing.modifiedAt) agents.set(agent.sessionId, agent);
      }
    }
  }

  return [...sessions, ...agents.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function findJsonlFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await listNoting(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && /\.jsonl(\.zst)?$/.test(entry.name)) files.push(fullPath);
    }
  }

  return files;
}

function sessionIdFromCodexFilename(filePath) {
  const base = path.basename(filePath).replace(/\.zst$/, '');
  const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match ? match[1] : base.replace(/\.jsonl$/, '').replace(/^rollout-[^-]+-/, '');
}

const CODEX_HEADER_LINES = 400;

async function getCodexSessionDescriptor(filePath, archived = false) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;

  const filenameSessionId = sessionIdFromCodexFilename(filePath);
  let sessionId = null;
  let project = null;
  let startedAt = null;
  let lines = 0;
  // The metadata sits at the top of a rollout. A fork starts with its
  // parent's record, sometimes followed by its own; when its own never
  // comes, the first turn says where it ran. Reading stops there, because
  // this runs for every rollout on every command.
  await streamLines(filePath, (data) => {
      lines++;
      if (data.type === 'session_meta' && data.payload) {
        const candidateId = data.payload.id || data.payload.session_id;
        const isCanonical = candidateId && filenameSessionId && candidateId === filenameSessionId;
        if (!sessionId || isCanonical) {
          sessionId = candidateId || sessionId;
          project = data.payload.cwd || project;
          startedAt = data.payload.timestamp || data.timestamp || startedAt;
        }
        if (isCanonical && project) return true;
      } else if (data.type === 'turn_context' && data.payload) {
        project = data.payload.cwd || project;
        if (sessionId && project) return true;
      }
      if (lines >= CODEX_HEADER_LINES && sessionId) return true;
  });

  sessionId = filenameSessionId || sessionId;
  project ||= '(unknown)';
  if (!sessionId) return null;

  return {
    sessionId,
    shortId: makeShortId('codex', sessionId),
    source: 'codex',
    project,
    projectEncoded: project,
    filePath,
    size: stat.size,
    modifiedAt: stat.mtime,
    startedAt,
    archived
  };
}

let compressedSkipWarned = false;

// Drops compressed rollouts this Node cannot read, and says so once.
function readableRollouts(files) {
  if (zstdSupport()) return files;
  const readable = files.filter(file => !file.endsWith('.zst'));
  const skipped = files.length - readable.length;
  if (skipped > 0 && !compressedSkipWarned) {
    compressedSkipWarned = true;
    console.error(c.yellow(`${plural(skipped, 'compressed Codex session')} skipped: ${ZSTD_REQUIREMENT}.`));
  }
  return readable;
}

async function getCodexSessionFiles(projectFilter = null) {
  const activeFiles = readableRollouts(await findJsonlFiles(CODEX_SESSIONS_DIR));
  const archivedFiles = readableRollouts(await findJsonlFiles(CODEX_ARCHIVED_SESSIONS_DIR));
  const descriptors = [];
  for (const file of activeFiles) descriptors.push(await getCodexSessionDescriptor(file, false));
  for (const file of archivedFiles) descriptors.push(await getCodexSessionDescriptor(file, true));
  const filter = projectFilter ? projectFilter.toLowerCase() : null;
  const byId = new Map();

  for (const session of descriptors) {
    if (!session) continue;
    if (filter && !session.project.toLowerCase().includes(filter)) continue;
    const existing = byId.get(session.sessionId);
    const shouldReplace = !existing ||
      (existing.archived && !session.archived) ||
      (existing.archived === session.archived && session.modifiedAt > existing.modifiedAt);
    if (shouldReplace) {
      byId.set(session.sessionId, session);
    }
  }

  return [...byId.values()].sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// --- Kimi ---
// Kimi Code has two on-disk generations, both rooted at <root>/sessions/:
// - modern (~/.kimi-code): wd_<slug>_<hash>/session_<uuid>/ with metadata in
//   state.json (workDir, title) and the main agent's transcript in
//   agents/main/wire.jsonl (event-sourced wire protocol).
// - legacy (~/.kimi): <md5(workdir)>/<uuid>/ with the ready-made conversation
//   in context.jsonl. The project path comes from kimi.json's work_dirs
//   (bucket name is its md5) or, failing that, the session's system prompt.

function md5hex(value) {
  return createHash('md5').update(value).digest('hex');
}

async function getKimiLegacyWorkDirMap(root) {
  const map = new Map();
  try {
    const config = JSON.parse(await fs.readFile(path.join(root, 'kimi.json'), 'utf8'));
    for (const dir of config.work_dirs || []) {
      if (dir && dir.path) map.set(md5hex(dir.path), dir.path);
    }
  } catch {}
  return map;
}

async function resolveKimiLegacyProject(bucketDir, bucket, workDirMap) {
  if (workDirMap.has(bucket)) return workDirMap.get(bucket);
  const entries = await fs.readdir(bucketDir).catch(() => []);
  for (const entry of entries) {
    const contextPath = path.join(bucketDir, entry, 'context.jsonl');
    if (!existsSync(contextPath)) continue;
    let cwd = null;
    await streamLines(contextPath, (data) => {
      if (data.role === '_system_prompt' && typeof data.content === 'string') {
        const match = data.content.match(/working directory is `([^`]+)`/);
        if (match) { cwd = match[1]; return true; }
      }
    });
    if (cwd) return cwd;
  }
  return bucket;
}

async function getKimiSessionDescriptors() {
  const descriptors = [];
  for (const root of KIMI_ROOTS) {
    const sessionsRoot = path.join(root, 'sessions');
    if (!existsSync(sessionsRoot)) continue;
    const legacyWorkDirs = await getKimiLegacyWorkDirMap(root);
    const buckets = await listNoting(sessionsRoot);

    for (const bucket of buckets) {
      const bucketDir = path.join(sessionsRoot, bucket);
      const bucketStat = await statNoting(bucketDir);
      if (!bucketStat || !bucketStat.isDirectory()) continue;
      const isModern = bucket.startsWith('wd_');
      let legacyProject = null;
      const entries = await listNoting(bucketDir);

      for (const entry of entries) {
        const sessionDir = path.join(bucketDir, entry);
        const sessionStat = await statNoting(sessionDir);
        if (!sessionStat || !sessionStat.isDirectory()) continue;

        let sessionId;
        let transcriptPath;
        let format;
        let project;
        let title = null;
        let startedAt = null;
        let archived = false;
        if (isModern && entry.startsWith('session_')) {
          sessionId = entry.slice('session_'.length);
          transcriptPath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
          format = 'wire';
          project = null;
          try {
            const state = JSON.parse(await fs.readFile(path.join(sessionDir, 'state.json'), 'utf8'));
            project = state.workDir || state.cwd || null;
            title = typeof state.title === 'string' && state.title.trim() ? state.title.trim() : null;
            startedAt = kimiTimestamp(state.createdAt) || null;
            archived = state.archived === true;
          } catch {}
          project ||= bucket;
        } else if (!isModern) {
          sessionId = entry;
          transcriptPath = path.join(sessionDir, 'context.jsonl');
          format = 'context';
          legacyProject ||= await resolveKimiLegacyProject(bucketDir, bucket, legacyWorkDirs);
          project = legacyProject;
        } else {
          continue;
        }

        const stat = await statNoting(transcriptPath);
        if (!stat || !stat.isFile()) continue;

        descriptors.push({
          sessionId,
          shortId: makeShortId('kimi', sessionId),
          source: 'kimi',
          project,
          projectEncoded: bucket,
          filePath: transcriptPath,
          format,
          title,
          ...(title ? { named: true } : {}),
          startedAt,
          archived,
          size: stat.size,
          modifiedAt: stat.mtime
        });
      }
    }
  }
  return descriptors;
}

async function getKimiSessionFiles(projectFilter = null) {
  const filter = projectFilter ? projectFilter.toLowerCase() : null;
  const descriptors = await getKimiSessionDescriptors();
  return descriptors
    .filter(session => !filter ||
      session.project.toLowerCase().includes(filter) ||
      session.projectEncoded.toLowerCase().includes(filter))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function normalizeKimiContextRecord(data) {
  if (data.role === 'user') {
    const text = extractTextContent(data.content);
    if (!text || !text.trim()) return [];
    return [{
      type: 'user',
      source: 'kimi',
      message: { role: 'user', content: [{ type: 'text', text }] }
    }];
  }

  if (data.role === 'assistant') {
    const content = [];
    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        // Think blocks are dropped entirely so no output format (including
        // --json) can expose chain-of-thought.
        if (block && block.type === 'text' && block.text) content.push({ type: 'text', text: block.text });
      }
    }
    for (const call of data.tool_calls || []) {
      content.push({
        type: 'tool_use',
        name: call.function?.name || call.type || 'tool',
        input: parseToolInput(call.function?.arguments)
      });
    }
    if (content.length === 0) return [];
    return [{
      type: 'assistant',
      source: 'kimi',
      message: { role: 'assistant', content }
    }];
  }

  return [];
}

function kimiTimestamp(value) {
  return timestampDate(value)?.toISOString() || undefined;
}

// Reconstructs messages from the modern wire protocol: user input arrives as
// context.append_message events (origin.kind 'user'; 'injection' events are
// internal reminders), assistant output streams as per-step loop events which
// are grouped into one assistant message per step.
async function streamKimiWireMessages(session, callback) {
  const state = { model: null, step: null };
  let stopped = false;

  const emit = (message) => {
    if (callback(message) === true) {
      stopped = true;
      return true;
    }
    return false;
  };

  const flushStep = () => {
    const step = state.step;
    state.step = null;
    if (!step || step.content.length === 0) return false;
    return emit({
      type: 'assistant',
      source: 'kimi',
      timestamp: step.timestamp,
      message: { role: 'assistant', model: state.model || undefined, content: step.content }
    });
  };

  await streamLines(session.filePath, (data) => {
    if (data.type === 'llm.request') {
      if (data.model) state.model = data.model;
      return;
    }

    if (data.type === 'context.append_message') {
      if (flushStep()) return true;
      const msg = data.message || {};
      const kind = msg.origin?.kind;
      if (msg.role !== 'user' || (msg.origin && kind !== 'user')) return;
      const text = extractTextContent(msg.content);
      if (!text || !text.trim()) return;
      return emit({
        type: 'user',
        source: 'kimi',
        timestamp: kimiTimestamp(data.time),
        message: { role: 'user', content: [{ type: 'text', text }] }
      });
    }

    if (data.type !== 'context.append_loop_event') return;
    const event = data.event || {};

    if (event.type === 'step.begin') {
      if (flushStep()) return true;
      state.step = { timestamp: kimiTimestamp(data.time), content: [] };
      return;
    }
    if (event.type === 'step.end') {
      if (flushStep()) return true;
      return;
    }
    if (event.type === 'content.part') {
      const part = event.part || {};
      if (part.type !== 'text' || !part.text) return; // think parts are dropped entirely
      if (!state.step) state.step = { timestamp: kimiTimestamp(data.time), content: [] };
      state.step.content.push({ type: 'text', text: part.text });
      return;
    }
    if (event.type === 'tool.call') {
      if (!state.step) state.step = { timestamp: kimiTimestamp(data.time), content: [] };
      state.step.content.push({ type: 'tool_use', name: event.name || 'tool', input: parseToolInput(event.args) });
    }
  });

  if (!stopped) flushStep();
}

async function getKimiHistoryWorkDirMap() {
  const map = new Map();
  for (const root of KIMI_ROOTS) {
    for (const [hash, dir] of await getKimiLegacyWorkDirMap(root)) map.set(hash, dir);
  }
  for (const session of await getKimiSessionDescriptors()) {
    if (session.format === 'wire' && session.project) map.set(md5hex(session.project), session.project);
  }
  return map;
}


// subagents: also return Claude subagent transcripts, which search, show,
// export, label and sync read, and listings leave out.
async function getSessionFiles(projectFilter = null, source = 'all', { subagents = false } = {}) {
  const selected = parseSource(source);
  const include = (name) => selected === 'all' || selected === name;
  const groups = await Promise.all([
    include('claude') ? getClaudeSessionFiles(projectFilter, { subagents }) : [],
    include('codex') ? getCodexSessionFiles(projectFilter) : [],
    include('kimi') ? getKimiSessionFiles(projectFilter) : []
  ]);
  return groups.flat().sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function aggregateSessionsByProject(sessions, source) {
  const byProject = new Map();
  for (const session of sessions) {
    const current = byProject.get(session.project) || {
      encoded: session.project,
      path: session.project,
      source,
      sessionCount: 0,
      totalSize: 0
    };
    current.sessionCount++;
    current.totalSize += session.size;
    byProject.set(session.project, current);
  }
  return [...byProject.values()];
}

async function getAllProjects(source = 'all') {
  const selected = parseSource(source);
  const include = (name) => selected === 'all' || selected === name;
  const claudeProjects = include('claude') ? await getClaudeProjects() : [];
  const codexSessions = include('codex') ? await getCodexSessionFiles() : [];
  const kimiSessions = include('kimi') ? await getKimiSessionFiles() : [];

  // Several Cowork sessions can have worked in one folder, and each keeps
  // its transcripts apart: they count as one project. What discovery needs
  // to find its way around (dir, desktop) stays out of what is reported.
  const claudeByPath = new Map();
  for (const project of claudeProjects) {
    const known = claudeByPath.get(project.path);
    if (known) {
      known.sessionCount += project.sessionCount;
      known.totalSize += project.totalSize;
    } else {
      claudeByPath.set(project.path, {
        encoded: project.encoded,
        path: project.path,
        source: project.source,
        sessionCount: project.sessionCount,
        totalSize: project.totalSize
      });
    }
  }

  const combined = [
    ...claudeByPath.values(),
    ...aggregateSessionsByProject(codexSessions, 'codex'),
    ...aggregateSessionsByProject(kimiSessions, 'kimi')
  ];
  if (selected !== 'all') return combined.sort((a, b) => a.path.localeCompare(b.path));

  const merged = new Map();
  for (const project of combined) {
    const current = merged.get(project.path) || {
      encoded: project.encoded,
      path: project.path,
      source: project.source,
      sources: {},
      sessionCount: 0,
      totalSize: 0
    };
    current.sources[project.source] = (current.sources[project.source] || 0) + project.sessionCount;
    current.sessionCount += project.sessionCount;
    current.totalSize += project.totalSize;
    if (current.source !== project.source) current.source = 'all';
    if (project.source === 'claude') current.encoded = project.encoded;
    merged.set(project.path, current);
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function codexTextBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(block => block && ['input_text', 'output_text', 'text'].includes(block.type) && typeof block.text === 'string')
    .map(block => ({ type: 'text', text: block.text }));
}

function isInternalCodexUserText(text) {
  const match = text.trim().match(/^<([a-z0-9_]+)>[\s\S]*<\/\1>$/);
  if (!match) return false;
  if (match[1].startsWith('external_codex_apps_')) return true;
  return ['environment_context', 'turn_aborted', 'recommended_plugins'].includes(match[1]);
}

function parseToolInput(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeCodexRecord(data, state) {
  if (data.type === 'turn_context' && data.payload?.model) state.model = data.payload.model;

  if (data.type === 'event_msg') {
    const role = data.payload?.type === 'user_message' ? 'user' : data.payload?.type === 'agent_message' ? 'assistant' : null;
    const text = data.payload?.message;
    if (role === 'user' && typeof text === 'string' && isInternalCodexUserText(text)) return [];
    if (role && typeof text === 'string' && text.trim()) {
      return [{
        type: role,
        source: 'codex',
        _representation: 'event',
        timestamp: data.timestamp,
        message: { role, model: role === 'assistant' ? state.model : undefined, content: [{ type: 'text', text }] }
      }];
    }
  }

  if (data.type === 'response_item' && data.payload?.type === 'message') {
    const role = data.payload.role;
    if (role !== 'user' && role !== 'assistant') return [];
    let content = codexTextBlocks(data.payload.content);
    if (role === 'user') content = content.filter(block => !isInternalCodexUserText(block.text));
    if (content.length === 0) return [];
    return [{
      type: role,
      source: 'codex',
      _representation: 'response',
      timestamp: data.timestamp,
      message: { role, model: role === 'assistant' ? state.model : undefined, content }
    }];
  }

  if (data.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(data.payload?.type)) {
    const input = data.payload.type === 'function_call' ? data.payload.arguments : data.payload.input;
    return [{
      type: 'assistant',
      source: 'codex',
      _representation: 'tool',
      timestamp: data.timestamp,
      message: {
        role: 'assistant',
        model: state.model,
        content: [{ type: 'tool_use', name: data.payload.name || data.payload.type, input: parseToolInput(input) }]
      }
    }];
  }

  return [];
}

// Claude Code stores a prompt typed while the agent is still working as a
// queued command attachment, not a user record. Those are as much the user's
// words as any other prompt. The same attachment type also carries task
// notifications, which are not.
function claudeQueuedPrompt(data) {
  const attachment = data.attachment;
  if (!attachment || attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null;
  if (attachment.origin?.kind && attachment.origin.kind !== 'human') return null;
  const content = typeof attachment.prompt === 'string'
    ? [{ type: 'text', text: attachment.prompt }]
    : Array.isArray(attachment.prompt) ? attachment.prompt.filter(block => block && typeof block === 'object') : [];
  if (!hasTextContent(content)) return null;
  return {
    type: 'user',
    source: 'claude',
    queued: true,
    cwd: data.cwd,
    timestamp: attachment.timestamp || data.timestamp,
    message: { role: 'user', content }
  };
}

async function streamSessionMessages(session, callback) {
  if (session.source === 'claude') {
    await streamLines(session.filePath, (data) => {
      if (data.type === 'attachment') {
        const queued = claudeQueuedPrompt(data);
        return queued ? callback(queued) : undefined;
      }
      if (!['user', 'assistant', 'summary'].includes(data.type)) return;
      return callback({ ...data, source: 'claude' });
    });
    return;
  }

  if (session.source === 'kimi') {
    if (session.format === 'wire') {
      await streamKimiWireMessages(session, callback);
      return;
    }
    await streamLines(session.filePath, (data) => {
      for (const message of normalizeKimiContextRecord(data)) {
        if (callback(message) === true) return true;
      }
    });
    return;
  }

  const state = { model: null };
  let pending = null;
  let stopped = false;

  const emit = (message) => {
    const { _representation, ...normalized } = message;
    if (callback(normalized) === true) {
      stopped = true;
      return true;
    }
    return false;
  };

  await streamLines(session.filePath, (data) => {
    const messages = normalizeCodexRecord(data, state);
    for (const message of messages) {
      const pendingText = pending ? extractTextContent(pending.message?.content) : '';
      const messageText = extractTextContent(message.message?.content);
      const isDuplicatePair = pending &&
        pending.type === message.type &&
        pendingText && pendingText === messageText &&
        pending._representation !== message._representation &&
        [pending._representation, message._representation].every(kind => ['event', 'response'].includes(kind));

      if (isDuplicatePair) {
        if (message._representation === 'event') pending = message;
        continue;
      }

      if (pending && emit(pending)) return true;
      pending = message;
    }
  }, isUnusedCodexLine);
  if (!stopped && pending) emit(pending);
}

function isDisplayPrompt(source, text) {
  const trimmed = text.trim();
  if (source === 'claude') {
    return !/^<(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)(?:\s|>)/.test(trimmed) &&
      !trimmed.startsWith('Caveat: The messages below were generated by the user');
  }
  if (source === 'codex') return !trimmed.startsWith('# Files mentioned by the user:');
  return true;
}

async function getSessionMeta(session, includeActivity = false) {
  let firstPrompt = null;
  let displayPrompt = null;
  let timestamp = null;
  let userCount = 0;
  let assistantCount = 0;
  let model = null;
  const activityByDay = includeActivity ? {} : null;

  await streamSessionMessages(session, (data) => {
    if (includeActivity && (data.type === 'user' || data.type === 'assistant')) {
      const date = timestampDate(data.timestamp);
      if (date) {
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        activityByDay[day] = (activityByDay[day] || 0) + 1;
      }
    }
    if (data.type === 'user') {
      userCount++;
      const text = extractTextContent(data.message?.content);
      if (!firstPrompt) {
        if (text) firstPrompt = text;
        if (data.timestamp) timestamp = data.timestamp;
      }
      if (includeActivity && !displayPrompt && text && isDisplayPrompt(session.source, text)) {
        displayPrompt = text;
      }
    } else if (data.type === 'assistant') {
      assistantCount++;
      if (!model && data.message?.model) model = data.message.model;
    }
  });

  const meta = { firstPrompt, timestamp, userCount, assistantCount, model, messageCount: userCount + assistantCount };
  if (includeActivity) {
    meta.activityByDay = activityByDay;
    meta.displayPrompt = displayPrompt || (firstPrompt && !isDisplayPrompt(session.source, firstPrompt)
      ? session.source === 'claude' ? 'Local command session' : session.source === 'codex' ? 'Session with attached files' : firstPrompt
      : firstPrompt);
  }
  return meta;
}

async function getSessionMetaFast(session) {
  let firstPrompt = null;
  let timestamp = null;
  let model = null;

  await streamSessionMessages(session, (data) => {
    if (data.type === 'user' && !firstPrompt) {
      const text = extractTextContent(data.message?.content);
      if (text) firstPrompt = text;
      if (data.timestamp) timestamp = data.timestamp;
    }
    if (data.type === 'assistant' && !model && data.message?.model) {
      model = data.message.model;
    }
    if (firstPrompt && model) return true;
  });

  return { firstPrompt, timestamp, model };
}

function timestampDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function getHistoryEntries(source = 'all') {
  const selected = parseSource(source);
  const include = (name) => selected === 'all' || selected === name;
  const entries = [];

  if (include('claude') && existsSync(CLAUDE_HISTORY_FILE)) {
    await streamLines(CLAUDE_HISTORY_FILE, (data) => {
      entries.push({ ...data, source: 'claude' });
    });
  }

  if (include('codex')) {
    const codexSessions = await getCodexSessionFiles();
    const sessionsById = new Map(codexSessions.map(session => [session.sessionId, session]));
    const historySessionIds = new Set();
    if (existsSync(CODEX_HISTORY_FILE)) await streamLines(CODEX_HISTORY_FILE, (data) => {
      if (typeof data.text !== 'string' || !data.text.trim() || isInternalCodexUserText(data.text)) return;
      historySessionIds.add(data.session_id);
      const session = sessionsById.get(data.session_id);
      const timestamp = timestampDate(data.ts)?.toISOString() || null;
      entries.push({
        source: 'codex',
        sessionId: data.session_id || null,
        timestamp,
        projectPath: session?.project || '',
        display: data.text
      });
    });
    // Desktop chats may never appear in the CLI's global history. Use their
    // normalized transcript prompts, preserving repeats and source timestamps.
    // Global history remains authoritative for sessions it already contains.
    for (const session of codexSessions) {
      if (historySessionIds.has(session.sessionId)) continue;
      await streamSessionMessages(session, (message) => {
        if (message.type !== 'user') return;
        const display = extractTextContent(message.message?.content);
        if (!display.trim()) return;
        entries.push({
          source: 'codex',
          sessionId: session.sessionId,
          timestamp: timestampDate(message.timestamp)?.toISOString() || null,
          projectPath: session.project,
          display
        });
      });
    }
  }

  if (include('kimi')) {
    const workDirMap = await getKimiHistoryWorkDirMap();
    const seen = new Set();
    for (const root of KIMI_ROOTS) {
      const historyDir = path.join(root, 'user-history');
      if (!existsSync(historyDir)) continue;
      const files = await fs.readdir(historyDir).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const projectPath = workDirMap.get(file.replace(/\.jsonl$/, '')) || '';
        await streamLines(path.join(historyDir, file), (data) => {
          if (typeof data.content !== 'string' || !data.content.trim()) return;
          // The CLI's home migration copied user-history files verbatim, so
          // the same file can exist under both roots.
          const dedupeKey = `${file}:${data.content}`;
          if (seen.has(dedupeKey)) return;
          seen.add(dedupeKey);
          entries.push({
            source: 'kimi',
            sessionId: null,
            timestamp: timestampDate(data.timestamp)?.toISOString() || null,
            projectPath,
            display: data.content
          });
        });
      }
    }
  }

  return entries.sort((a, b) => {
    const aTime = timestampDate(a.timestamp || a.ts)?.getTime() || 0;
    const bTime = timestampDate(b.timestamp || b.ts)?.getTime() || 0;
    return bTime - aTime;
  });
}

function findSessions(sessions, rawIdFragment) {
  let idFragment = rawIdFragment;
  let source = null;
  const qualified = rawIdFragment.match(/^(claude|codex|kimi):(.+)$/i);
  if (qualified) {
    source = qualified[1].toLowerCase();
    idFragment = qualified[2];
  }
  // Kimi names its session folders session_<id>, and that is the form people paste.
  idFragment = idFragment.replace(/^session_/, '');
  const candidates = source ? sessions.filter(s => s.source === source) : sessions;
  const exact = candidates.filter(s => s.sessionId === idFragment || s.shortId === idFragment);
  if (exact.length > 0) return exact;
  return candidates.filter(s => s.sessionId.startsWith(idFragment));
}

function resolveSession(sessions, idFragment) {
  const matches = findSessions(sessions, idFragment);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return null;
  const choices = matches.map(s => `${s.source}:${s.sessionId}`).join(', ');
  throw new Error(`Ambiguous session ID "${idFragment}". Use --source or a qualified ID: ${choices}`);
}

function formatMessageBlock(msg, opts = {}) {
  const termWidth = process.stdout.columns || 120;
  const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';

  if (msg.type === 'summary') {
    return c.italic.dim(`  Summary: ${truncate(msg.summary, termWidth - 12)}`);
  }

  if (msg.type === 'user') {
    const text = extractTextContent(msg.message?.content);
    if (!text || !text.trim()) return null;
    const header = c.bold.cyan(`\u25b6 ${opts.userLabel || 'You'}`) + c.dim(` ${ts}`) + (opts.tag || '');
    return header + '\n' + wrapText(text, termWidth);
  }

  if (msg.type === 'assistant') {
    const modelName = msg.message?.model || msg.source || 'assistant';
    const content = msg.message?.content;
    const parts = [];

    if (typeof content === 'string') {
      if (content.trim()) parts.push(wrapText(content, termWidth));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          parts.push(wrapText(block.text, termWidth));
        } else if (block.type === 'tool_use' && !opts.noTools) {
          const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
          parts.push(c.dim(`  \u{1f527} ${block.name}: ${truncate(inputStr, termWidth - 10)}`));
        }
      }
    }

    if (parts.length === 0) return null;

    const header = c.bold.green(`\u25c0 ${speakerName(msg.source)}`) + c.dim(` (${modelName}) ${ts}`) + (opts.tag || '');
    return header + '\n' + parts.join('\n');
  }

  return null;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError('port must be an integer between 0 and 65535');
  }
  return port;
}

function parseActiveMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new InvalidArgumentError('active minutes must be a positive number');
  }
  return minutes;
}

function parseCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return count;
}

function parseSeq(value) {
  const seq = Number(value);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new InvalidArgumentError('must be a message position such as 12');
  }
  return seq;
}

function parseRole(value) {
  const role = String(value).toLowerCase();
  if (role === 'you') return 'user';
  if (role !== 'user' && role !== 'assistant') {
    throw new InvalidArgumentError('role must be user or assistant');
  }
  return role;
}

function parseSearchSort(value) {
  const sort = String(value).toLowerCase();
  if (sort !== 'relevance' && sort !== 'recent') {
    throw new InvalidArgumentError('sort must be relevance or recent');
  }
  return sort;
}

function sinceFromOptions(opts) {
  return opts.days ? daysToSinceDate(parseInt(opts.days)) : opts.since ? new Date(opts.since) : null;
}

function plural(count, word) {
  return `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : (word.endsWith('ch') ? 'es' : 's')}`;
}

// --- search rendering shared by both backends ---

// Lines around each literal occurrence of the query, with the match painted.
function literalSnippets(text, query) {
  const lowerQuery = query.toLowerCase();
  const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const lines = cleanSnippet(text).split('\n').filter(l => l.trim());
  const matchLines = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(lowerQuery)) continue;
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length - 1, i + 1);
    const snippet = [];
    for (let j = start; j <= end; j++) {
      if (seen.has(j)) continue;
      seen.add(j);
      let l = lines[j];
      if (l.length > 200) l = l.slice(0, 200) + '…';
      if (j === i) l = l.replace(pattern, m => c.bold.yellow(m));
      snippet.push(l);
    }
    if (snippet.length > 0) matchLines.push(snippet.join('\n'));
  }
  return matchLines;
}

// "you" is reserved for what the user typed; text a tool injected under the
// user role (notifications, command output) reads as "system".
function speakerTag(r) {
  if (r.type === 'title') return c.dim('title');
  if (r.injected) return c.dim('system');
  return r.type === 'user' ? c.cyan('you') : c.green(r.source);
}

// How a subagent transcript is marked wherever a session is named.
function subagentNote(parentSessionId) {
  return `(subagent of ${makeShortId('claude', parentSessionId || '')})`;
}

// Header lines that say what a subagent transcript is and how to reach the
// session it worked for. Empty for an ordinary session.
function subagentHeader(session) {
  if (!session.subagent) return [];
  const kind = [session.agentType, session.title].filter(Boolean).join(': ');
  return [
    `Subagent of: ${session.parentSessionId}${kind ? ` (${kind})` : ''}`
  ];
}

const DESKTOP_TABS = { code: 'Code tab', cowork: 'Cowork', chat: 'Cowork chat', scheduled: 'Cowork scheduled task' };

// Header lines for what is known about a session beyond its transcript: the
// name it was given, the app it ran in, the session a subagent worked for.
function sessionHeader(session) {
  const lines = subagentHeader(session);
  if (session.title && !session.subagent) lines.push(`Title: ${session.title}`);
  if (session.app === 'desktop') lines.push(`App: Claude desktop (${DESKTOP_TABS[session.desktopKind] || session.desktopKind || 'session'})`);
  return lines;
}

function printSearchMatch(r, totalInSession) {
  const time = r.timestamp ? formatRelativeTime(r.timestamp) : '';
  const who = speakerTag(r);
  const hits = totalInSession > 1 ? c.dim(` (${totalInSession} matches in session)`) : '';
  // The message position, when known, is what "show --around" takes.
  const position = r.seq === undefined ? '' : c.dim(` #${r.seq}`);
  console.log(
    c.yellow(r.shortId) + ' ' +
    sourceTag(r.source) + ' ' +
    c.dim(r.project) + ' ' +
    (r.subagent ? c.dim(`${subagentNote(r.parentSessionId)} `) : '') +
    (r.app ? c.dim(`${desktopNote(r)} `) : '') +
    who + ' ' +
    c.dim(time) +
    position +
    hits
  );
  printSearchBody(r);
}

function printSearchBody(r) {
  const contextLine = (ctx) => {
    const ctxWho = ctx.type === 'user' ? c.dim.cyan('  [you]') : c.dim.green(`  [${r.source}]`);
    console.log(ctxWho + c.dim(` ${ctx.text}`));
  };
  for (const ctx of (r.contextMessages || []).filter(m => m.position === 'before')) contextLine(ctx);
  for (const snippet of r.snippets) {
    console.log('  ' + snippet.split('\n').map(l => '  ' + l).join('\n'));
  }
  for (const ctx of (r.contextMessages || []).filter(m => m.position === 'after')) contextLine(ctx);
}

function printSessionPrompts(prompts) {
  if (prompts.length === 0) return;
  console.log(c.dim('  --- session prompts ---'));
  for (const p of prompts) {
    console.log(c.dim(`    ${p.time}`) + `  ${p.text}`);
  }
}

// --- Elasticsearch backend ---

// Turns a highlighted fragment into one painted terminal line.
function paintFragment(fragment, open, close) {
  return fragment
    .replace(/\s+/g, ' ')
    .trim()
    .split(open)
    .map((part, index) => {
      if (index === 0) return part;
      const [match, ...rest] = part.split(close);
      return c.bold.yellow(match) + rest.join('');
    })
    .join('');
}

function describeScope(scope = {}) {
  const parts = [];
  if (scope.source && scope.source !== 'all') parts.push(`${scope.source} only`);
  if (scope.project) parts.push(`project ${scope.project}`);
  if (scope.since) parts.push(`since ${String(scope.since).slice(0, 10)}`);
  return parts.join(', ');
}

// Search answers from the index as of its last sync, so say how old that is.
function snapshotFooter(snapshot) {
  const synced = snapshot.syncedAt ? formatRelativeTime(snapshot.syncedAt) : 'at an unknown time';
  const ageMs = snapshot.syncedAt ? Date.now() - snapshot.syncedAt.getTime() : Infinity;
  let hint = ageMs > 60 * 60_000 ? '; run "sessions sync" to include newer messages' : '';
  // Counted just now, or left by the last sync and kept with its record.
  const backlog = snapshot.backlog || snapshot.meta?.last_sync?.left;
  if (backlog?.sessions > 0) {
    hint = `; ${plural(backlog.sessions, 'session')} (${formatSize(backlog.bytes)}) not indexed yet, run "sessions sync"`;
  }
  return `Elasticsearch index synced ${synced}${hint}`;
}

function formatLabels(labels) {
  return Object.entries(labels || {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
    .join(' ');
}

function collectOption(value, previous = []) {
  return [...previous, value];
}

// Shown when a search had to loosen the match to find anything.
const SEARCH_MODE_NOTES = {
  prefix: 'No exact word match; showing words that start with your terms.',
  literal: 'No word match; showing literal substring matches.',
  tools: 'No message text matches; showing tool calls (commands, paths, arguments) that do.',
  session: 'No single message contains every term; showing sessions that contain them all.',
  fuzzy: 'No exact match; showing similar spellings.',
  partial: 'No message contains every term; showing the closest matches.'
};

// With auto_sync set, a search first brings the index up to date when its
// last sync is older than that many minutes. Only changed transcripts are
// re-read, so this usually takes a second or two.
//
// Whoever is searching is waiting, so a search reads at most auto_sync_max_mb
// of transcript. It takes the newest sessions that fit and leaves the rest,
// and says what it left. Taking nothing when the total is too large would
// freeze the index for as long as one big session keeps changing.
async function refreshIfStale(elastic, client, config, snapshot) {
  const es = config.elasticsearch;
  if (!es.autoSyncMinutes || !snapshot.syncedAt) return snapshot;
  if (Date.now() - snapshot.syncedAt.getTime() < es.autoSyncMinutes * 60_000) return snapshot;
  if (snapshot.meta?.schema !== elastic.SCHEMA_VERSION) return snapshot;
  if (!isLoopbackUrl(es.url) && !es.allowRemote) return snapshot;
  try {
    const everything = await getSessionFiles(null, 'all', { subagents: true });
    const appVisible = (await desktopSessions()).visible;
    const waiting = elastic.pendingSessions(everything, await elastic.indexedSessions(client, snapshot.index), { appVisible });
    const budget = es.autoSyncMaxMb * 1024 * 1024;
    const taken = [];
    const left = [];
    let used = 0;
    for (const session of waiting) {
      const size = session.size || 0;
      if (used + size <= budget) {
        taken.push(session);
        used += size;
      } else {
        left.push(session);
      }
    }

    const backlog = { sessions: left.length, bytes: left.reduce((sum, session) => sum + (session.size || 0), 0) };
    let refreshed = snapshot;
    if (taken.length > 0 || waiting.length === 0) {
      await elastic.syncIndex({
        client,
        alias: es.index,
        keep: es.keep,
        sessions: waiting.length === 0 ? everything : taken,
        allSessionKeys: everything.map(sessionKey),
        reader: { streamSessionMessages, extractTextContent, isDisplayPrompt },
        scope: { source: 'all', project: null, since: null },
        toolVersion: pkg.version,
        appVisible,
        // Kept with the sync's record: the searches that follow within the
        // auto_sync interval do not count again, and still have to say it.
        left: backlog
      });
      refreshed = (await elastic.currentSnapshot(client, es.index)) || snapshot;
    }
    if (left.length === 0) return refreshed;
    return { ...refreshed, backlog };
  } catch (error) {
    if (error.name !== 'ElasticError') throw error;
    console.error(c.dim(`Could not refresh the index (${error.message}); results are as of the last sync.`));
    return snapshot;
  }
}

function projectName(project) {
  const name = String(project || '').replace(/\/+$/, '').split('/').pop();
  return name || String(project || '');
}

// One line per facet, in sessions: where the matches are and how to narrow.
function printFacets(facets) {
  const line = (label, buckets, name = bucket => bucket.value) => {
    if (buckets.length < 2) return;
    console.log(c.dim(`${label} ${buckets.map(bucket => `${name(bucket)} ${bucket.sessions}`).join(', ')}`));
  };
  line('Projects:', facets.projects, bucket => projectName(bucket.value));
  line('When:', facets.when);
  line('Sources:', facets.sources);
}

// --- search: two backends, one presenter ---
//
// Both backends answer the same query language and return the same outcome:
//   backend    'elasticsearch' or 'files'
//   mode       how the query was matched (see SEARCH_MODE_NOTES)
//   rows       the matches to show, best session first
//   totals     { messages, sessions } across everything that was searched
//   inSession  set when --session narrowed the search to one session
//   partial    files only: { scanned, available } when the scan stopped early
//   facets     Elasticsearch only: where and when the matches are
//   prompts    Map(session key -> first prompts), for --preview
//   notice     a first line saying why the index was not used, if it was not
//   footer     a closing line, such as how fresh the index is

// The lines shown under one match: highlighted stretches of the message, then
// of its tool calls, or the start of the message when nothing is highlighted.
function hitSnippets(hit, query, mode) {
  if (mode === 'literal' && hit.text) {
    const literal = literalSnippets(hit.text, query).slice(0, 2);
    if (literal.length > 0) return literal;
  }
  const paint = fragment => paintFragment(fragment, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE);
  const snippets = hit.fragments.slice(0, 2).map(paint);
  if (hit.toolFragments.length > 0) {
    const label = hit.tools.length > 0 ? hit.tools.join(', ') : 'tool';
    snippets.push(c.dim(`\u{1f527} ${label}: `) + paint(hit.toolFragments[0]));
  }
  if (snippets.length === 0 && hit.preview) snippets.push(hit.preview);
  return snippets;
}

// Answers a search from the Elasticsearch index. Returns the outcome, or a
// sentence saying why the index could not answer.
async function searchElastic(query, opts, config) {
  const elastic = await import('./lib/elastic.js');
  const es = config.elasticsearch;
  const client = elastic.createClient({ ...es, timeoutMs: 20_000 });
  let snapshot = await elastic.currentSnapshot(client, es.index);
  if (!snapshot) {
    return `Elasticsearch at ${client.url} has no "${es.index}" index yet (run "sessions sync")`;
  }
  snapshot = await refreshIfStale(elastic, client, config, snapshot);

  let labels;
  try {
    labels = (opts.label || []).map(elastic.parseLabel);
  } catch (error) {
    failWith(error.message);
  }

  // --session drills into one session: its matches in the order they were said.
  let inSession = null;
  if (opts.session) {
    const found = await elastic.findIndexedSessions(client, snapshot.index, opts.session);
    if (found.length === 0) failWith(`No indexed session matches "${opts.session}".`);
    if (found.length > 1) {
      failWith(`"${opts.session}" matches several sessions: ${found.map(s => `${s.source}:${s.sessionId}`).join(', ')}`);
    }
    inSession = found[0];
  }

  const limit = parseInt(opts.limit);
  const contextN = parseInt(opts.context);
  const result = await elastic.searchSnapshot(client, snapshot.index, {
    query,
    literal: Boolean(opts.literal),
    sort: opts.sort || 'relevance',
    limit,
    perSession: opts.perSession || 1,
    includeTools: Boolean(opts.tools),
    inSession: inSession ? inSession.sessionKey : null,
    filters: {
      source: opts.source,
      project: opts.project,
      since: sinceFromOptions(opts),
      role: opts.role,
      tool: opts.tool,
      labels
    }
  });

  // A session whose name holds every term is an outright match, so messages
  // that only matched once the search had loosened give way to it. That is
  // also what the file scan does.
  const titles = result.titles || [];
  const byName = titles.length > 0 && result.mode !== 'smart' && result.mode !== 'literal';
  if (byName) {
    result.mode = 'smart';
    result.groups = [];
    result.totalMessages = 0;
    result.totalSessions = 0;
    result.facets = null;
  }

  // -n caps the matches shown. Sessions come best first and each contributes
  // up to --per-session matches.
  const hits = result.groups.flatMap(group => group.hits.map(hit => ({ hit, group }))).slice(0, limit);
  const shownSessions = [...new Set(hits.map(({ hit }) => hit.sessionKey))];
  const [context, sessionLabels, prompts] = await Promise.all([
    elastic.fetchContext(client, snapshot.index, hits.map(({ hit }) => hit), contextN),
    elastic.getLabels(client, snapshot.index, shownSessions),
    opts.preview && !opts.json ? elastic.fetchPrompts(client, snapshot.index, shownSessions) : new Map()
  ]);
  const rows = hits.map(({ hit, group }) => {
    const row = {
      sessionId: hit.sessionId,
      shortId: hit.shortId,
      source: hit.source,
      project: hit.project,
      timestamp: hit.timestamp,
      type: hit.role,
      model: hit.model || undefined,
      snippets: hitSnippets(hit, query, result.mode),
      contextMessages: (context.get(`${hit.sessionKey}:${hit.seq}`) || []).map(message => ({ ...message, text: truncate(message.text, 150) })),
      score: hit.score,
      matchesInSession: group.matchesInSession,
      matchMode: result.mode,
      seq: hit.seq,
      tools: hit.tools,
      _sessionKey: hit.sessionKey
    };
    if (hit.injected) row.injected = true;
    if (hit.subagent) {
      row.subagent = true;
      row.parentSessionId = hit.parentSessionId;
    }
    if (hit.app) {
      row.app = hit.app;
      row.desktopKind = hit.desktopKind;
    }
    // Label fields appear only when something is labeled.
    const ofSession = sessionLabels.get(hit.sessionKey);
    if (ofSession) row.sessionLabels = ofSession;
    if (hit.labels) row.labels = hit.labels;
    return row;
  });

  // Sessions the query names, and no message of which matched, come first.
  // They are few, and a name that matches is rarely an accident. When more
  // than one row is asked for, at least one stays with the messages that
  // matched; with a single row, the name is the answer.
  const room = rows.length === 0 ? limit : Math.max(1, limit - 1);
  const named = titles.slice(0, Math.max(1, room)).map((entry) => {
    const row = {
      sessionId: entry.sessionId,
      shortId: entry.shortId,
      source: entry.source,
      project: entry.project,
      timestamp: entry.timestamp,
      type: 'title',
      snippets: [paintFragment(entry.fragment, HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE)],
      contextMessages: [],
      matchesInSession: 1,
      matchMode: result.mode,
      seq: 0,
      tools: [],
      title: entry.title,
      _sessionKey: entry.sessionKey
    };
    if (entry.app) {
      row.app = entry.app;
      row.desktopKind = entry.desktopKind;
    }
    return row;
  });
  rows.unshift(...named);
  rows.splice(Math.max(limit, 1));

  return {
    backend: 'elasticsearch',
    mode: result.mode,
    rows,
    totals: { messages: result.totalMessages + titles.length, sessions: result.totalSessions + titles.length },
    inSession: inSession ? { shortId: inSession.shortId, source: inSession.source, project: inSession.project } : null,
    partial: null,
    facets: result.facets,
    prompts,
    notice: null,
    footer: snapshotFooter(snapshot)
  };
}

async function firstPrompts(session, count = 5) {
  const prompts = [];
  await streamSessionMessages(session, (data) => {
    if (data.type !== 'user') return;
    const text = extractTextContent(data.message?.content);
    if (!text || !text.trim()) return;
    prompts.push({ text, timestamp: data.timestamp || null });
    if (prompts.length >= count) return true;
  });
  return prompts;
}

// Answers a search by reading the session files, newest session first.
async function searchLocal(query, opts) {
  const { searchFiles } = await import('./lib/local-search.js');
  const limit = parseInt(opts.limit);
  let sessions = await getSessionFiles(opts.project, opts.source, { subagents: true });
  const since = sinceFromOptions(opts);
  if (since) sessions = sessions.filter(s => s.modifiedAt >= since);

  let inSession = null;
  if (opts.session) {
    try {
      inSession = resolveSession(await getSessionFiles(null, opts.source, { subagents: true }), opts.session);
    } catch (error) {
      failWith(error.message);
    }
    if (!inSession) failWith(`Session not found: ${opts.session}`);
    const wanted = sessionKey(inSession);
    sessions = sessions.filter(s => sessionKey(s) === wanted);
  }

  const result = await searchFiles({
    query,
    sessions,
    reader: { streamSessionMessages, extractTextContent },
    limit,
    perSession: opts.perSession || 1,
    context: parseInt(opts.context),
    literal: Boolean(opts.literal),
    includeTools: Boolean(opts.tools),
    tool: opts.tool || null,
    role: opts.role || null,
    sort: opts.sort || 'relevance',
    inSession: Boolean(inSession)
  });

  const picked = result.groups.flatMap(group => group.hits.map(hit => ({ hit, group }))).slice(0, limit);
  const rows = picked.map(({ hit, group }) => {
    const { session } = group;
    const nearby = (position) => (message) => ({ type: message.type, text: truncate(message.text, 150), position });
    const row = {
      sessionId: session.sessionId,
      shortId: session.shortId,
      source: session.source,
      project: session.project,
      timestamp: hit.timestamp,
      type: hit.role,
      model: hit.model || undefined,
      snippets: hitSnippets(hit, query, result.mode),
      contextMessages: [...hit.before.map(nearby('before')), ...hit.after.map(nearby('after'))],
      matchesInSession: group.matchesInSession,
      matchMode: result.mode,
      seq: hit.seq,
      tools: hit.tools,
      _sessionKey: sessionKey(session)
    };
    if (hit.injected) row.injected = true;
    if (session.subagent) {
      row.subagent = true;
      row.parentSessionId = session.parentSessionId;
    }
    if (session.app) {
      row.app = session.app;
      row.desktopKind = session.desktopKind;
    }
    if (group.title) row.title = group.title;
    return row;
  });

  const prompts = new Map();
  if (opts.preview && !opts.json) {
    const shown = new Map(picked.map(({ group }) => [sessionKey(group.session), group.session]));
    for (const [key, session] of shown) prompts.set(key, await firstPrompts(session));
  }

  return {
    backend: 'files',
    mode: result.mode,
    rows,
    totals: { messages: result.totalMessages, sessions: result.totalSessions },
    inSession: inSession ? { shortId: inSession.shortId, source: inSession.source, project: inSession.project } : null,
    partial: result.complete ? null : { scanned: result.scanned, available: result.available },
    facets: null,
    prompts,
    notice: null,
    footer: null
  };
}

// Picks the backend for a search and returns its outcome. The index answers
// when one is configured and reachable; otherwise the session files do, and
// the outcome says why. Only labels have no file-scan equivalent.
async function runSearch(query, opts) {
  const config = await loadConfig({ overrides: { backend: opts.local ? 'local' : undefined } });
  if (config.warning) console.error(c.yellow(config.warning));
  const es = config.elasticsearch;
  const backend = config.search.backend;
  const wantsLabels = Boolean(opts.label?.length);
  const useElastic = backend === 'elasticsearch' || (backend === 'auto' && Boolean(es.url));

  if (!useElastic) {
    if (wantsLabels) {
      failWith(es.url
        ? '--label needs the Elasticsearch index, and this search is set to scan files (--local or search.backend: local).'
        : 'Labels are kept in the optional Elasticsearch index. Run "sessions sync" to set one up.');
    }
    return searchLocal(query, opts);
  }

  let failure;
  if (!es.url) {
    failure = 'No Elasticsearch URL is configured (set SESSIONS_ES_URL or elasticsearch.url in ~/.sessions/config.yaml)';
  } else {
    try {
      const outcome = await searchElastic(query, opts, config);
      if (typeof outcome !== 'string') return outcome;
      failure = outcome;
    } catch (error) {
      if (error.name !== 'ElasticError') throw error;
      failure = error.message;
    }
  }
  if (backend === 'elasticsearch' || wantsLabels) failWith(failure);

  const outcome = await searchLocal(query, opts);
  outcome.notice = `${failure}. Scanning session files instead.`;
  return outcome;
}

function printSearchOutcome(query, opts, outcome) {
  const { rows, inSession, totals } = outcome;
  if (opts.json) {
    // JSON on stdout has to stay parseable, so the notice goes to stderr.
    if (outcome.notice) console.error(c.dim(outcome.notice));
    console.log(JSON.stringify(rows.map(({ _sessionKey, ...rest }) => rest), null, 2));
    return;
  }

  // In the results themselves, where whoever reads them will see it.
  if (outcome.notice) console.log(c.dim(outcome.notice));
  if (rows.length === 0) {
    console.log(inSession ? `No matches for "${query}" in ${inSession.shortId}.` : `No matches for "${query}".`);
    if (outcome.footer) console.log(c.dim(outcome.footer));
    return;
  }

  const shownSessions = new Set(rows.map(row => row._sessionKey));
  if (inSession) {
    const shown = rows.length < totals.messages ? c.dim(` (showing ${rows.length})`) : '';
    console.log(c.bold(`${plural(totals.messages, 'match')} in `) + c.yellow(inSession.shortId) + ' ' +
      sourceTag(inSession.source) + ' ' + c.dim(inSession.project) + shown);
  } else if (outcome.partial) {
    console.log(c.bold(`Newest ${plural(shownSessions.size, 'matching session')}`) +
      c.dim(` (read ${outcome.partial.scanned} of ${plural(outcome.partial.available, 'session')}, newest first)`));
  } else {
    const shown = shownSessions.size < totals.sessions ? c.dim(` (showing ${shownSessions.size})`) : '';
    console.log(c.bold(`${plural(totals.messages, 'match')} in ${plural(totals.sessions, 'session')}`) + shown);
  }
  if (!opts.literal && SEARCH_MODE_NOTES[outcome.mode]) console.log(c.dim(SEARCH_MODE_NOTES[outcome.mode]));

  const previewShown = new Set();
  const spaced = parseInt(opts.context) > 0 || Boolean(opts.preview);
  for (const row of rows) {
    if (inSession) {
      const time = row.timestamp ? formatRelativeTime(row.timestamp) : '';
      console.log(`${c.dim(`#${row.seq}`)} ${speakerTag(row)} ${c.dim(time)}`);
      printSearchBody(row);
    } else {
      printSearchMatch(row, row.matchesInSession);
    }
    const rowLabels = formatLabels(inSession ? row.labels : { ...row.sessionLabels, ...row.labels });
    if (rowLabels) console.log(c.dim(`    labels: ${rowLabels}`));
    if (opts.preview && !previewShown.has(row._sessionKey)) {
      previewShown.add(row._sessionKey);
      printSessionPrompts((outcome.prompts.get(row._sessionKey) || []).map(p => ({
        text: truncate(p.text, 100),
        time: p.timestamp ? formatRelativeTime(p.timestamp) : ''
      })));
    }
    if (spaced) console.log('');
  }

  // What else is there, and how to get closer.
  if (!spaced) console.log('');
  const top = rows[0];
  if (inSession) {
    console.log(c.dim(`Read around a match: sessions show ${top.shortId} --around ${top.seq}`));
  } else {
    if (outcome.facets && shownSessions.size < totals.sessions) printFacets(outcome.facets);
    // A session found by its name has no matching message to drill into.
    console.log(c.dim(top.type === 'title'
      ? `Read it: sessions show ${top.shortId}`
      : `Drill in: add --session ${top.shortId} for every match in that session, or run: sessions show ${top.shortId} --around ${top.seq}`));
    if (outcome.partial) console.log(c.dim('Older sessions were not read. Raise -n to go further back, or narrow with -p, --days or --since.'));
  }
  if (outcome.footer) console.log(c.dim(outcome.footer));
}

// The named volume keeps the index, and the labels that live only in it, when
// the container is removed; the restart policy brings it back with Docker.
const LOCAL_ES_COMMAND = 'docker run -d --name sessions-es --restart unless-stopped -p 127.0.0.1:9220:9200 ' +
  '-v sessions-es:/usr/share/elasticsearch/data ' +
  '-e discovery.type=single-node -e xpack.security.enabled=false ' +
  '-e ES_JAVA_OPTS="-Xms1g -Xmx1g" elasticsearch:8.19.25';

function failWith(message) {
  console.error(c.red(message));
  process.exit(1);
}

async function printSyncStatus(elastic, client, es, opts) {
  const [info, details] = await Promise.all([elastic.clusterInfo(client), elastic.snapshotDetails(client, es.index)]);
  let pending = null;
  let labels = [];
  if (details) {
    const local = await getSessionFiles(null, 'all', { subagents: true });
    const appVisible = (await desktopSessions()).visible;
    [pending, labels] = await Promise.all([
      elastic.indexedSessions(client, details.index).then(indexed => elastic.compareWithIndex(local, indexed, { appVisible })),
      elastic.labelSummary(client, details.index)
    ]);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      url: client.url,
      version: info.version,
      alias: es.index,
      index: details ? {
        name: details.index,
        createdAt: details.createdAt,
        syncedAt: details.syncedAt,
        lastSync: details.meta?.last_sync || null,
        sessions: details.sessions,
        messages: details.messages,
        storeBytes: details.storeBytes,
        pending,
        labels
      } : null
    }, null, 2));
    return;
  }

  console.log(`${c.bold('Elasticsearch')}  ${client.url} ${c.dim(`(${info.version})`)}`);
  if (!details) {
    console.log(`${c.bold('Index')}          none for "${es.index}" yet; run "sessions sync"`);
    return;
  }
  const lastScope = describeScope(details.meta?.last_sync?.scope);
  console.log(`${c.bold('Index')}          ${es.index} -> ${details.index}`);
  console.log(`${c.bold('Synced')}         ${details.syncedAt
    ? `${formatRelativeTime(details.syncedAt)} ${c.dim(`(${details.syncedAt.toISOString()}${lastScope ? `, ${lastScope}` : ''})`)}`
    : 'unknown'}`);
  console.log(`${c.bold('Contents')}       ${plural(details.messages, 'message')} in ${plural(details.sessions, 'session')}, ${formatSize(details.storeBytes)} on disk`);
  const waiting = pending.changed + pending.added;
  const parts = [];
  if (waiting > 0) parts.push(`${pending.changed} changed, ${pending.added} new ${c.dim(`(${formatSize(pending.bytes)} to read; run "sessions sync")`)}`);
  if (pending.missing > 0) parts.push(`${pending.missing} no longer on disk`);
  console.log(`${c.bold('Since sync')}     ${parts.length > 0 ? parts.join('; ') : 'no local changes'}`);
  if (labels.length > 0) {
    console.log(`${c.bold('Labels')}         ${labels.map(entry => `${entry.key} ${c.dim(`(${plural(entry.values.length, 'value')})`)}`).join(', ')}`);
  }
}

async function runSync(opts) {
  const config = await loadConfig({
    overrides: { url: opts.esUrl, index: opts.index, keep: opts.keep, allowRemote: opts.allowRemote }
  });
  if (config.warning) console.error(c.yellow(config.warning));
  const es = config.elasticsearch;

  if (!isValidIndexName(es.index)) {
    failWith(`Invalid index name "${es.index}". Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`);
  }
  if (!es.url && !opts.dryRun) {
    failWith(
      'No Elasticsearch URL is configured. Elasticsearch is optional; to try it on this machine:\n' +
      `  ${LOCAL_ES_COMMAND}\n  export SESSIONS_ES_URL=http://127.0.0.1:9220\n  sessions sync\n` +
      'To keep it, set elasticsearch.url in ~/.sessions/config.yaml instead of the export. --es-url works too.'
    );
  }
  if (es.url && !opts.status && !opts.dryRun && !isLoopbackUrl(es.url) && !es.allowRemote) {
    failWith(
      `Refusing to touch ${displayUrl(es.url)}: it is not this machine, and transcripts can hold private material.\n` +
      'Pass --allow-remote or set elasticsearch.allow_remote: true to send them there anyway.'
    );
  }

  const elastic = await import('./lib/elastic.js');
  const client = es.url ? elastic.createClient(es) : null;

  try {
    if (opts.status) {
      await printSyncStatus(elastic, client, es, opts);
      return;
    }

    if (opts.drop) {
      const removed = await elastic.dropSnapshots(client, es.index);
      if (opts.json) {
        console.log(JSON.stringify({ removed }, null, 2));
        return;
      }
      console.log(removed.length === 0
        ? `No "${es.index}" index to remove.`
        : `Removed ${removed.join(', ')}`);
      return;
    }

    const everything = await getSessionFiles(null, 'all', { subagents: true });
    if (opts.prune && unreadableFolders.size > 0) {
      failWith(`Not pruning: ${plural(unreadableFolders.size, 'folder')} could not be read (${[...unreadableFolders.keys()].map(tildePath).join(', ')}), ` +
        'so sessions in them would look deleted. Run again without --prune, or once they can be read.');
    }
    const since = sinceFromOptions(opts);
    let sessions = opts.project || opts.source !== 'all' ? await getSessionFiles(opts.project, opts.source, { subagents: true }) : everything;
    if (since) sessions = sessions.filter(s => s.modifiedAt >= since);
    const info = opts.dryRun ? null : await elastic.clusterInfo(client);

    const showProgress = process.stderr.isTTY && !opts.json;
    const totals = await elastic.syncIndex({
      client,
      alias: es.index,
      keep: es.keep,
      sessions,
      allSessionKeys: everything.map(sessionKey),
      reader: { streamSessionMessages, extractTextContent, isDisplayPrompt },
      scope: { source: opts.source, project: opts.project || null, since: since ? since.toISOString() : null },
      toolVersion: pkg.version,
      appVisible: (await desktopSessions()).visible,
      rebuild: Boolean(opts.rebuild),
      prune: Boolean(opts.prune),
      dryRun: Boolean(opts.dryRun),
      onProgress: ({ done, total, messages }) => {
        if (showProgress) process.stderr.write(`\r  ${done}/${total} sessions, ${messages.toLocaleString('en-US')} messages`);
      }
    });
    if (showProgress) process.stderr.write(`\r${' '.repeat(60)}\r`);

    if (opts.json) {
      console.log(JSON.stringify({ ...totals, url: client?.url || null, alias: es.index, version: info?.version || null }, null, 2));
    } else {
      const counted = `${plural(totals.sessions, 'session')}, ${plural(totals.messages, 'message')}`;
      let headline;
      if (totals.dryRun) headline = `Would index ${counted}`;
      else if (totals.mode === 'create') headline = `Indexed ${counted}`;
      else if (totals.mode === 'rebuild') headline = `Rebuilt the index from ${counted}`;
      else if (totals.sessions === 0) headline = `Already up to date: ${plural(totals.unchanged, 'session')} unchanged`;
      else headline = `Synced ${plural(totals.sessions, 'changed session')}, ${plural(totals.messages, 'message')}`;
      const detail = totals.sessions > 0 ? ` (${formatSize(totals.textChars)} of text)` : '';
      console.log(c.bold(headline) + c.dim(`${detail} in ${(totals.durationMs / 1000).toFixed(1)}s`));

      const notes = [];
      const sources = Object.entries(totals.bySource).map(([source, count]) => `${source} ${count}`).join(', ');
      if (sources) notes.push(totals.mode === 'update' ? `${sources}; ${plural(totals.unchanged, 'session')} unchanged` : sources);
      if (totals.subagents > 0) notes.push(`${plural(totals.subagents, 'subagent transcript')} among them`);
      if (!totals.dryRun) notes.push(`${es.index} -> ${totals.index} at ${client.url} (Elasticsearch ${info.version})`);
      if (totals.reason === 'schema') notes.push('the index format changed, so it was rebuilt');
      if (totals.carried.sessions > 0) notes.push(`kept ${plural(totals.carried.sessions, 'session')} outside this run as they were`);
      if (totals.carried.enriched > 0) notes.push(`kept labels and notes on ${plural(totals.carried.enriched, 'document')}`);
      if (totals.removed.length > 0) notes.push(`removed ${totals.removed.join(', ')}`);
      if (totals.staleRemoved > 0) notes.push(`removed ${plural(totals.staleRemoved, 'message')} no longer in their transcripts`);
      if (totals.pruned > 0) notes.push(`pruned ${plural(totals.pruned, 'session')} no longer on disk`);
      else if (totals.missing > 0) notes.push(`${plural(totals.missing, 'session')} no longer on disk stay searchable; --prune removes them`);
      if (totals.truncatedMessages > 0) notes.push(`${plural(totals.truncatedMessages, 'message')} longer than 500,000 characters indexed in part`);
      for (const note of notes) console.log(c.dim(`  ${note}`));
      for (const line of totals.unreadable.slice(0, 3)) console.error(c.yellow(`  skipped ${line}`));
      if (totals.unreadable.length > 3) console.error(c.yellow(`  ...and ${totals.unreadable.length - 3} more skipped sessions`));
    }
    if (totals.failed > 0) {
      console.error(c.red(`${plural(totals.failed, 'document')} failed to index; the next sync retries their sessions:`));
      for (const sample of totals.failureSamples) console.error(c.red(`  ${sample}`));
      process.exit(1);
    }
  } catch (error) {
    if (error.name !== 'ElasticError') throw error;
    failWith(error.message);
  }
}

// Connects to the configured index for the label commands, or exits.
async function requireIndex() {
  const config = await loadConfig();
  if (config.warning) console.error(c.yellow(config.warning));
  const es = config.elasticsearch;
  if (!es.url) {
    failWith('Labels are kept in the optional Elasticsearch index. Run "sessions sync" to set one up.');
  }
  const elastic = await import('./lib/elastic.js');
  const client = elastic.createClient(es);
  const snapshot = await elastic.currentSnapshot(client, es.index);
  if (!snapshot) failWith(`Elasticsearch at ${client.url} has no "${es.index}" index yet (run "sessions sync")`);
  return { elastic, client, snapshot };
}

async function runLabel(sessionId, pairs, opts) {
  try {
    const { elastic, client, snapshot } = await requireIndex();
    const set = {};
    const remove = opts.remove || [];
    try {
      for (const pair of pairs) {
        const { key, value } = elastic.parseLabel(pair);
        set[key] = value;
      }
      for (const key of remove) {
        if (!elastic.isValidLabelKey(key)) throw new Error(`Invalid label key "${key}": use letters, digits, "_" or "-"`);
      }
    } catch (error) {
      failWith(error.message);
    }

    const sessions = await getSessionFiles(null, opts.source, { subagents: true });
    let session;
    try {
      session = resolveSession(sessions, sessionId);
    } catch (error) {
      failWith(error.message);
    }
    if (!session) failWith(`Session not found: ${sessionId}`);

    const key = sessionKey(session);
    const id = opts.message === undefined ? key : `${key}:${opts.message}`;
    const changing = Object.keys(set).length > 0 || remove.length > 0;
    const labels = changing
      ? await elastic.updateLabels(client, snapshot.index, id, { set, remove })
      : await elastic.readLabels(client, snapshot.index, id);
    if (labels === null) {
      failWith(opts.message === undefined
        ? `${key} is not in the index yet; run "sessions sync" first`
        : `${key} has no indexed message ${opts.message}`);
    }

    if (opts.json) {
      console.log(JSON.stringify({
        sessionId: session.sessionId,
        source: session.source,
        message: opts.message ?? null,
        labels
      }, null, 2));
      return;
    }
    const target = c.yellow(session.shortId) + ' ' + sourceTag(session.source) +
      (opts.message === undefined ? '' : c.dim(` message ${opts.message}`));
    console.log(`${target} ${formatLabels(labels) || c.dim('(no labels)')}`);
  } catch (error) {
    if (error.name !== 'ElasticError') throw error;
    failWith(error.message);
  }
}

async function runLabels(opts) {
  try {
    const { elastic, client, snapshot } = await requireIndex();
    const summary = await elastic.labelSummary(client, snapshot.index);
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (summary.length === 0) {
      console.log('No labels yet. Add one with: sessions label <session-id> key=value');
      return;
    }
    for (const entry of summary) {
      const values = entry.values.map(item => `${item.value} ${c.dim(`(${plural(item.sessions, 'session')})`)}`).join(', ');
      console.log(`${c.cyan(entry.key)}  ${values}`);
    }
  } catch (error) {
    if (error.name !== 'ElasticError') throw error;
    failWith(error.message);
  }
}

function tildePath(file) {
  const home = os.homedir();
  return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

const INIT_WORDS = {
  created: ['created', 'would create'],
  added: ['added', 'would add'],
  updated: ['updated', 'would update'],
  unchanged: ['already up to date', 'already up to date'],
  removed: ['removed', 'would remove'],
  absent: ['nothing to remove', 'nothing to remove']
};

// Adds, updates or removes the managed note in each installed agent's global
// instructions file.
async function runInit(opts) {
  const agents = await import('./lib/agents.js');
  if (opts.print) {
    process.stdout.write(agents.instructionBlock());
    return;
  }

  const known = agents.agentTargets();
  const wanted = (opts.agent || []).map(name => String(name).toLowerCase());
  for (const name of wanted) {
    if (!known.some(target => target.agent === name)) {
      failWith(`Unknown agent "${name}". Expected one of: ${known.map(target => target.agent).join(', ')}.`);
    }
  }
  const targets = wanted.length > 0 ? known.filter(target => wanted.includes(target.agent)) : known;

  const results = [];
  for (const target of targets) {
    const result = { agent: target.agent, name: target.name, file: target.file, change: null, notes: [] };
    results.push(result);
    if (!existsSync(target.home)) {
      result.change = 'not installed';
      continue;
    }
    let existing = null;
    try {
      existing = await fs.readFile(target.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        result.change = 'failed';
        result.notes.push(error.message);
        continue;
      }
    }
    const { text, change } = opts.remove ? agents.removeBlock(existing) : agents.applyBlock(existing);
    result.change = change;
    if (!['unchanged', 'absent'].includes(change) && !opts.dryRun) {
      try {
        // A file that held nothing but the note goes away with it.
        if (opts.remove && text === '') await fs.rm(target.file);
        else await fs.writeFile(target.file, text);
      } catch (error) {
        result.change = 'failed';
        result.notes.push(error.message);
        continue;
      }
    }
    if (opts.remove) continue;
    if (target.shadowedBy) {
      const shadow = await fs.readFile(target.shadowedBy, 'utf8').catch(() => '');
      if (shadow.trim()) result.notes.push(`${target.name} reads ${tildePath(target.shadowedBy)} instead for as long as that file has content`);
    }
    if (agents.mentionsOutsideBlock(text)) {
      result.notes.push(`${tildePath(target.file)} also describes sessions outside this note; that older text can go`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const nameWidth = Math.max(...results.map(result => result.name.length));
    const fileWidth = Math.max(...results.map(result => tildePath(result.file).length));
    for (const result of results) {
      const said = result.change === 'not installed'
        ? c.dim(`not installed (no ${tildePath(path.dirname(result.file))})`)
        : result.change === 'failed'
          ? c.red('failed')
          : INIT_WORDS[result.change][opts.dryRun ? 1 : 0];
      console.log(`${result.name.padEnd(nameWidth)}  ${tildePath(result.file).padEnd(fileWidth)}  ${said}`);
      for (const note of result.notes) console.log(c.dim(`  ${note}`));
    }
  }

  const installed = results.filter(result => result.change !== 'not installed');
  if (installed.length === 0) {
    failWith('No Claude Code, Codex or Kimi Code installation was found, so there is nothing to tell.');
  }
  if (results.some(result => result.change === 'failed')) process.exit(1);
  if (opts.json || opts.dryRun) return;
  if (opts.remove) return;
  if (installed.some(result => ['created', 'added', 'updated'].includes(result.change))) {
    console.log(c.dim('\nSessions started from now on will read it. "sessions init --remove" takes it out again.'));
  }
}

if (process.argv[2] === '--serve') process.argv[2] = 'serve';

program
  .name('sessions')
  .description('Search and browse Claude Code, Codex, and Kimi session transcripts')
  .version(pkg.version)
  .option('--serve', 'Start the local web dashboard (alias for serve)')
  .addHelpText('after', `
Most used:
  sessions search "deploy staging"          messages containing both words; "phrase", OR and NOT work
  sessions search "deploy" --session <id>   every match in one session
  sessions show <id> --around 42            the conversation around match #42
  sessions list -p <project> --days 7       recent sessions
  sessions guide                            the whole tool in one screen, written for agents`);

program
  .command('serve')
  .description('Serve a live local dashboard of active and past sessions')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on (0 chooses a free port)', parsePort, 4220)
  .option('--active-minutes <minutes>', 'Consider sessions active for this long after updates', parseActiveMinutes, 15)
  .option('--open', 'Open the dashboard in your default browser')
  .action(async (opts) => {
    const { startSessionServer } = await import('./lib/server.js');
    await startSessionServer({ ...opts, getSessionFiles, getSessionMeta, streamSessionMessages, extractTextContent });
  });

program
  .command('list')
  .description('List sessions across all projects')
  .option('-p, --project <path>', 'Filter by project path (substring match)')
  .option('-n, --limit <n>', 'Max sessions to show', '20')
  .option('--since <date>', 'Sessions since date (YYYY-MM-DD)')
  .option('--days <n>', 'Sessions from last N days')
  .option('--full', 'Show full message counts (slower)')
  .option('--preview', 'Show first few prompts per session')
  .option('--subagents', 'Include Claude subagent transcripts')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    let sessions = await getSessionFiles(opts.project, opts.source, { subagents: Boolean(opts.subagents) });
    const limit = parseInt(opts.limit);

    const since = opts.days ? daysToSinceDate(parseInt(opts.days)) : opts.since ? new Date(opts.since) : null;
    if (since) {
      sessions = sessions.filter(s => s.modifiedAt >= since);
    }

    const shown = sessions.slice(0, limit);

    if (opts.json) {
      const out = [];
      for (const s of shown) {
        const meta = opts.full ? await getSessionMeta(s) : await getSessionMetaFast(s);
        out.push({ ...s, ...meta, display: meta.firstPrompt || null });
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (shown.length === 0) {
      console.log('No sessions found.');
      // With no filter in the way, say where sessions were expected.
      if (!opts.project && !since) {
        const roots = [];
        if (opts.source === 'all' || opts.source === 'claude') roots.push(PROJECTS_DIR);
        if (opts.source === 'all' || opts.source === 'codex') roots.push(CODEX_SESSIONS_DIR);
        if (opts.source === 'all' || opts.source === 'kimi') roots.push(...KIMI_ROOTS.map(root => path.join(root, 'sessions')));
        console.log(c.dim(`Looked in: ${roots.map(tildePath).join(', ')}`));
      }
      return;
    }

    console.log(c.bold(`${sessions.length} sessions`) + c.dim(` (showing ${shown.length})\n`));

    for (const s of shown) {
      const meta = opts.full ? await getSessionMeta(s) : await getSessionMetaFast(s);
      const prompt = meta.firstPrompt ? truncate(meta.firstPrompt, 90) : null;
      // A session that was given a name leads with it (a subagent, with what
      // it was asked to do); the prompt it began with follows unless the name
      // already says the same.
      const name = typeof s.title === 'string' && s.title ? s.title : null;
      const firstLine = !name
        ? prompt || c.dim('(empty)')
        : c.bold(name) + (prompt && !prompt.toLowerCase().startsWith(name.toLowerCase()) ? c.dim(`  ${truncate(meta.firstPrompt, 70)}`) : '');
      const time = formatRelativeTime(s.modifiedAt);
      const msgInfo = meta.messageCount ? `${meta.messageCount} msg` : '';

      console.log(
        c.yellow(s.shortId) + ' ' +
        sourceTag(s.source) + ' ' +
        c.dim(s.project) + ' ' +
        (s.subagent ? c.dim(`${subagentNote(s.parentSessionId)} `) : '') +
        (s.app ? c.dim(`${desktopNote(s)} `) : '') +
        c.cyan(time) + ' ' +
        (msgInfo ? c.dim(`(${msgInfo}) `) : '') +
        c.dim(formatSize(s.size))
      );

      if (opts.preview) {
        const prompts = [];
        let count = 0;
        await streamSessionMessages(s, (data) => {
          if (data.type === 'user') {
            const text = extractTextContent(data.message?.content);
            if (text && text.trim()) {
              const ts = data.timestamp ? formatRelativeTime(data.timestamp) : '';
              prompts.push({ text: truncate(text, 100), time: ts });
              count++;
              if (count >= 5) return true;
            }
          }
        });
        if (name) console.log(`  ${c.bold(name)}`);
        for (const p of prompts) {
          console.log(c.dim(`    ${p.time}`) + `  ${p.text}`);
        }
      } else {
        console.log(`  ${firstLine}`);
      }
      console.log('');
    }
  });

program
  .command('search <query>')
  .description('Full-text search across session transcripts')
  .option('-p, --project <path>', 'Filter by project path')
  .option('-n, --limit <n>', 'Max sessions to show', '10')
  .option('-C, --context <n>', 'Context messages around match', '0')
  .option('--since <date>', 'Only search sessions modified since date (YYYY-MM-DD)')
  .option('--days <n>', 'Only search sessions from last N days')
  .option('--preview', 'Show first few prompts per matched session')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--role <role>', 'Only match messages from: user or assistant', parseRole)
  .option('--session <id>', 'Every match inside one session, in the order it was said')
  .option('--per-session <n>', 'Matches shown per session (default: 1)', parseCount)
  .option('--tools', 'Also search tool calls: commands, file paths, arguments')
  .option('--tool <name>', 'Only match messages that called this tool, e.g. Bash')
  .option('--literal', 'Match the query as one exact substring')
  .option('--sort <order>', 'Result order: relevance or recent (without an index, sessions always come newest first)', parseSearchSort)
  .option('--local', 'Scan session files even when Elasticsearch is configured')
  .option('--label <key=value>', '[Elasticsearch] Only match labeled sessions or messages (repeatable)', collectOption)
  .option('--json', 'Output JSON')
  .addHelpText('after', `
A query means the same with or without an index:
  deploy staging        messages containing both words, in any order
  "exact phrase"        those words, in that order
  index.js              identifiers and paths match as a unit
  deploy OR release     either word (grep style works too: deploy\\|release)
  deploy NOT staging    exclude messages containing a word
  login.*timeout        grep style: both, in that order
Results list the best match of each session. To get closer:
  sessions search "deploy" --session a1b2c3d4     every match in that session
  sessions show a1b2c3d4 --around 42              the conversation around #42

Without an index, sessions are read newest first and words match as
substrings. Optional: "sessions sync" builds an Elasticsearch index, which
ranks results across everything, matches word forms and tolerates typos.`)
  .action(async (query, opts) => {
    printSearchOutcome(query, opts, await runSearch(query, opts));
  });

program
  .command('show <session-id>')
  .description('Display a session transcript')
  .option('--user-only', 'Show only user messages')
  .option('--assistant-only', 'Show only assistant messages')
  .option('--no-tools', 'Hide tool use blocks')
  .option('--preview', 'Show first few user prompts only (quick overview)')
  .option('-n, --limit <n>', 'Max messages to show')
  .option('--offset <n>', 'Skip first N messages', '0')
  .option('--around <position>', 'Show the conversation around a message position (the #N search prints)', parseSeq)
  .option('-C, --context <n>', 'Messages before and after --around', parseCount, 3)
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (sessionId, opts) => {
    if (opts.userOnly && opts.assistantOnly) {
      console.error(c.red('--user-only and --assistant-only cannot be used together.'));
      process.exit(1);
    }
    const sessions = await getSessionFiles(null, opts.source, { subagents: true });
    let session;
    try {
      session = resolveSession(sessions, sessionId);
    } catch (error) {
      console.error(c.red(error.message));
      process.exit(1);
    }

    if (!session) {
      console.error(c.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }

    if (opts.around !== undefined) {
      // Positions count every user and assistant message, the same way the
      // search index numbers them, so a search hit can be opened directly.
      const center = opts.around;
      const span = opts.context;
      const showOpts = { noTools: opts.tools === false, userLabel: session.subagent ? 'Parent agent' : null };
      const before = [];
      const window = [];
      let position = -1;
      let after = 0;
      await streamSessionMessages(session, (data) => {
        if (data.type !== 'user' && data.type !== 'assistant') return;
        position++;
        if (formatMessageBlock(data, showOpts) === null && position !== center) return;
        const entry = { position, data };
        if (position < center) {
          before.push(entry);
          if (before.length > span) before.shift();
        } else if (position === center) {
          window.push(...before, entry);
        } else {
          if (window.length === 0) window.push(...before);
          window.push(entry);
          if (++after >= span) return true;
        }
      });
      if (window.length === 0) window.push(...before);
      if (position < center) {
        console.error(c.red(`Session ${session.shortId} has ${position + 1} messages; there is no #${center}.`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(window.map(({ position: seq, data }) => ({ seq, ...data })), null, 2));
        return;
      }
      console.log(c.bold(`Session: ${session.sessionId}`));
      console.log(c.dim(`Source: ${session.source}`));
      console.log(c.dim(`Project: ${session.project}`));
      for (const line of sessionHeader(session)) console.log(c.dim(line));
      console.log(c.dim(`Around #${center} of ${session.shortId}\n`));
      for (const { position: seq, data } of window) {
        const tag = seq === center ? c.bold.yellow(` #${seq}`) : c.dim(` #${seq}`);
        const formatted = formatMessageBlock(data, { ...showOpts, tag });
        if (formatted !== null) console.log(formatted + '\n');
      }
      const first = window[0].position;
      const last = window[window.length - 1].position;
      console.log(c.dim(`Earlier: sessions show ${session.shortId} --around ${Math.max(0, first - 1)}   Later: sessions show ${session.shortId} --around ${last + 1}`));
      return;
    }

    const messages = [];
    let idx = 0;
    const offset = parseInt(opts.offset);
    const previewMode = opts.preview;
    const limit = opts.limit ? parseInt(opts.limit) : (previewMode ? 5 : Infinity);
    const noTools = opts.tools === false;
    const filterUser = previewMode ? !opts.assistantOnly : opts.userOnly;

    await streamSessionMessages(session, (data) => {
      if (data.type === 'summary') {
        if (!filterUser && !opts.assistantOnly) messages.push(data);
        return;
      }
      if (data.type !== 'user' && data.type !== 'assistant') return;
      if (filterUser && data.type !== 'user') return;
      if (opts.assistantOnly && data.type !== 'assistant') return;

      if (opts.assistantOnly || noTools) {
        if (!hasTextContent(data.message?.content)) return;
      }

      idx++;
      if (idx <= offset) return;
      if (messages.length >= limit) return true;
      messages.push(data);
    });

    if (opts.json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }

    console.log(c.bold(`Session: ${session.sessionId}`));
    console.log(c.dim(`Source: ${session.source}`));
    console.log(c.dim(`Project: ${session.project}`));
    for (const line of sessionHeader(session)) console.log(c.dim(line));
    console.log(c.dim(`Size: ${formatSize(session.size)}  Messages: ${messages.length}\n`));

    if (previewMode) {
      for (const msg of messages) {
        const text = extractTextContent(msg.message?.content);
        if (!text) continue;
        const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
        console.log(c.cyan(`  ${ts}`) + `  ${truncate(text, 100)}`);
      }
      return;
    }

    const showOpts = { noTools: noTools || opts.assistantOnly, userLabel: session.subagent ? 'Parent agent' : null };
    for (const msg of messages) {
      const formatted = formatMessageBlock(msg, showOpts);
      if (formatted !== null) console.log(formatted + '\n');
    }
  });

program
  .command('projects')
  .description('List all projects with session data')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    const projects = await getAllProjects(opts.source);

    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log('No projects found.');
      return;
    }

    console.log(c.bold(`${projects.length} projects\n`));

    for (const p of projects) {
      const sources = p.sources
        ? Object.entries(p.sources).map(([source, count]) => `${source}: ${count}`).join(', ')
        : `${p.source}: ${p.sessionCount}`;
      console.log(
        c.cyan(p.path) + ' ' +
        c.dim(`${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''}, ${formatSize(p.totalSize)} (${sources})`)
      );
    }
  });

program
  .command('export <session-id>')
  .description('Export a session transcript')
  .option('-f, --format <fmt>', 'Output format: md, json, text', 'md')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .action(async (sessionId, opts) => {
    if (!['md', 'json', 'text'].includes(opts.format)) {
      console.error(c.red(`Unsupported format: ${opts.format}. Use md, json, or text.`));
      process.exit(1);
    }
    const sessions = await getSessionFiles(null, opts.source, { subagents: true });
    let session;
    try {
      session = resolveSession(sessions, sessionId);
    } catch (error) {
      console.error(c.red(error.message));
      process.exit(1);
    }

    if (!session) {
      console.error(c.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }

    const messages = [];
    await streamSessionMessages(session, (data) => {
      if (data.type === 'user' || data.type === 'assistant' || data.type === 'summary') {
        messages.push(data);
      }
    });

    const contentMessages = messages.filter(msg => {
      if (msg.type === 'summary') return true;
      return hasTextContent(msg.message?.content);
    });

    let output = '';

    if (opts.format === 'json') {
      output = JSON.stringify(contentMessages, null, 2);
    } else if (opts.format === 'text') {
      for (const msg of contentMessages) {
        if (msg.type === 'summary') {
          output += `[SUMMARY] ${msg.summary}\n\n`;
          continue;
        }
        const text = extractTextContent(msg.message?.content);
        if (!text || !text.trim()) continue;
        const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
        const who = msg.type === 'user' ? 'YOU' : session.source.toUpperCase();
        const model = msg.message?.model ? ` (${msg.message.model})` : '';
        output += `[${who}${model}] ${ts}\n${text}\n\n`;
      }
    } else {
      output += `# Session: ${session.sessionId}\n\n`;
      output += `**Source:** ${session.source}  \n`;
      output += `**Project:** ${session.project}  \n`;
      output += `**Messages:** ${contentMessages.length}  \n\n---\n\n`;

      for (const msg of contentMessages) {
        if (msg.type === 'summary') {
          output += `> *Summary:* ${msg.summary}\n\n`;
          continue;
        }
        const text = extractTextContent(msg.message?.content);
        if (!text || !text.trim()) continue;
        const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
        const who = msg.type === 'user' ? '**You**' : `**${speakerName(session.source)}**`;
        const model = msg.message?.model ? ` *(${msg.message.model})*` : '';
        output += `### ${who}${model} \u2014 ${ts}\n\n${text}\n\n---\n\n`;
      }
    }

    if (opts.output) {
      await fs.writeFile(opts.output, output);
      console.error(`Written to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }
  });

program
  .command('history')
  .description('Show recent prompts from global history')
  .option('-n, --limit <n>', 'Max entries', '20')
  .option('-s, --search <query>', 'Filter by prompt text')
  .option('-p, --project <path>', 'Filter by project path')
  .option('--days <n>', 'Entries from last N days')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    let filtered = await getHistoryEntries(opts.source);
    if (opts.days) {
      const since = daysToSinceDate(parseInt(opts.days));
      filtered = filtered.filter(e => {
        const ts = timestampDate(e.timestamp || e.ts);
        return ts && ts >= since;
      });
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      filtered = filtered.filter(e => {
        const text = e.display || e.prompt || e.message || '';
        return text.toLowerCase().includes(q);
      });
    }
    if (opts.project) {
      const q = opts.project.toLowerCase();
      filtered = filtered.filter(e => (e.projectPath || e.project || '').toLowerCase().includes(q));
    }

    const shown = filtered.slice(0, parseInt(opts.limit));

    if (opts.json) {
      console.log(JSON.stringify(shown, null, 2));
      return;
    }

    if (shown.length === 0) {
      console.log('No history entries found.');
      return;
    }

    console.log(c.bold(`${filtered.length} entries`) + c.dim(` (showing ${shown.length})\n`));

    for (const e of shown) {
      const time = e.timestamp ? formatRelativeTime(e.timestamp) : '';
      const prompt = truncate(e.display || e.prompt || e.message || '(empty)', 100);
      const proj = e.projectPath || e.project || '';
      console.log(c.cyan(time) + ' ' + sourceTag(e.source) + ' ' + c.dim(proj));
      console.log(`  ${prompt}\n`);
    }
  });

program
  .command('recap')
  .description('Summarize recent session activity for a project')
  .option('-p, --project <path>', 'Filter by project path (substring match)')
  .option('-n, --limit <n>', 'Max sessions to include', '10')
  .option('--days <n>', 'Sessions from last N days', '14')
  .option('--prompts <n>', 'Max user prompts per session', '8')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    const days = parseInt(opts.days);
    const since = daysToSinceDate(days);
    let sessions = await getSessionFiles(opts.project, opts.source);
    sessions = sessions.filter(s => s.modifiedAt >= since);
    const shown = sessions.slice(0, parseInt(opts.limit));

    if (shown.length === 0) {
      if (opts.json) {
        console.log('[]');
        return;
      }
      console.log(`No sessions in the last ${days} days.`);
      return;
    }

    const maxPrompts = parseInt(opts.prompts);
    const recaps = [];

    for (const s of shown) {
      const prompts = [];
      let lastTimestamp = null;
      let userCount = 0;
      let assistantCount = 0;
      let model = null;

      await streamSessionMessages(s, (data) => {
        if (data.type === 'user') {
          userCount++;
          const text = extractTextContent(data.message?.content);
          if (text && text.trim()) {
            if (prompts.length < maxPrompts) {
              prompts.push({ text: text.trim(), timestamp: data.timestamp });
            }
          }
          if (data.timestamp) lastTimestamp = data.timestamp;
        } else if (data.type === 'assistant') {
          assistantCount++;
          if (!model && data.message?.model) model = data.message.model;
          if (data.timestamp) lastTimestamp = data.timestamp;
        }
      });

      recaps.push({
        sessionId: s.sessionId,
        shortId: s.shortId,
        source: s.source,
        project: s.project,
        size: s.size,
        modifiedAt: s.modifiedAt,
        model,
        userCount,
        assistantCount,
        prompts
      });
    }

    if (opts.json) {
      console.log(JSON.stringify(recaps, null, 2));
      return;
    }

    const byDay = new Map();
    for (const r of recaps) {
      const day = r.modifiedAt.toISOString().split('T')[0];
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }

    const projectLabel = opts.project || 'all projects';
    console.log(c.bold(`Recap: ${shown.length} sessions`) + c.dim(` (last ${days} days, ${projectLabel})\n`));

    for (const [day, daySessions] of byDay) {
      const dayDate = new Date(day + 'T12:00:00');
      const dayLabel = dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      console.log(c.bold.underline(dayLabel));

      for (const r of daySessions) {
        const msgCount = r.userCount + r.assistantCount;
        const header = c.yellow(r.shortId) + ' ' +
          sourceTag(r.source) + ' ' +
          c.dim(r.project) + ' ' +
          c.dim(`${msgCount} msgs, ${formatSize(r.size)}`) +
          (r.model ? c.dim(` (${r.model})`) : '');
        console.log('\n  ' + header);

        for (let i = 0; i < r.prompts.length; i++) {
          const p = r.prompts[i];
          const ts = p.timestamp ? formatRelativeTime(p.timestamp) : '';
          const num = c.dim(`${i + 1}.`);
          console.log(`    ${num} ${truncate(p.text, 110)}` + (ts ? c.dim(`  ${ts}`) : ''));
        }
        if (r.userCount > r.prompts.length) {
          console.log(c.dim(`    ... and ${r.userCount - r.prompts.length} more prompts`));
        }
      }
      console.log('');
    }
  });

program
  .command('activity')
  .description('Show a compact timeline of recent work across all projects')
  .option('--days <n>', 'Activity from last N days', '7')
  .option('-n, --limit <n>', 'Max sessions', '30')
  .option('-p, --project <path>', 'Filter by project path')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    const days = parseInt(opts.days);
    const since = daysToSinceDate(days);
    let sessions = await getSessionFiles(opts.project, opts.source);
    sessions = sessions.filter(s => s.modifiedAt >= since);
    const shown = sessions.slice(0, parseInt(opts.limit));

    if (shown.length === 0) {
      if (opts.json) {
        console.log('[]');
        return;
      }
      console.log(`No activity in the last ${days} days.`);
      return;
    }

    const activity = [];
    for (const s of shown) {
      const meta = await getSessionMetaFast(s);
      activity.push({
        sessionId: s.sessionId,
        shortId: s.shortId,
        source: s.source,
        project: s.project,
        modifiedAt: s.modifiedAt,
        size: s.size,
        firstPrompt: meta.firstPrompt,
        model: meta.model
      });
    }

    if (opts.json) {
      console.log(JSON.stringify(activity, null, 2));
      return;
    }

    const byProject = new Map();
    for (const a of activity) {
      if (!byProject.has(a.project)) byProject.set(a.project, []);
      byProject.get(a.project).push(a);
    }

    console.log(c.bold(`Activity: ${shown.length} sessions across ${byProject.size} projects`) + c.dim(` (last ${days} days)\n`));

    for (const [project, projectSessions] of byProject) {
      const totalSize = projectSessions.reduce((sum, s) => sum + s.size, 0);
      console.log(c.cyan.bold(project) + c.dim(` - ${projectSessions.length} sessions, ${formatSize(totalSize)}`));

      for (const s of projectSessions) {
        const time = formatRelativeTime(s.modifiedAt);
        const prompt = s.firstPrompt ? truncate(s.firstPrompt, 90) : c.dim('(empty)');
        console.log(`  ${c.yellow(s.shortId)} ${sourceTag(s.source)} ${c.dim(time)}  ${prompt}`);
      }
      console.log('');
    }
  });

program
  .command('guide')
  .description('Print a one-screen reference, written for the agents that use this tool')
  .action(async () => {
    const { guideText } = await import('./lib/agents.js');
    process.stdout.write(guideText());
  });

program
  .command('init')
  .description('Tell your agents about sessions: keep a short note in each one\'s global instructions')
  .option('--agent <name>', 'Only this agent: claude, codex, or kimi (repeatable)', collectOption)
  .option('--print', 'Print the note instead of writing it anywhere')
  .option('--dry-run', 'Show what would change without writing')
  .option('--remove', 'Remove the note again')
  .option('--json', 'Output JSON')
  .addHelpText('after', `
Agents use this tool, and one that was never told about it will not. This adds
a short managed block to the instructions each installed agent already reads:
  Claude Code   ~/.claude/CLAUDE.md
  Codex         ~/.codex/AGENTS.md
  Kimi Code     ~/.kimi-code/AGENTS.md
Everything outside the block is left alone, and running it again updates the
block in place. For a project-level file, paste the output of --print.`)
  .action(runInit);

program
  .command('sync')
  .description('Optional: index sessions into Elasticsearch for fast, ranked search')
  .option('-p, --project <path>', 'Only sync sessions whose project path matches')
  .option('--since <date>', 'Only sync sessions modified since date (YYYY-MM-DD)')
  .option('--days <n>', 'Only sync sessions from last N days')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--es-url <url>', 'Elasticsearch URL (default: SESSIONS_ES_URL or ~/.sessions/config.yaml)')
  .option('--index <name>', 'Alias and snapshot prefix (default: sessions)')
  .option('--keep <n>', 'Snapshots to keep after syncing (default: 1)', parseCount)
  .option('--allow-remote', 'Allow an Elasticsearch host other than this machine')
  .option('--rebuild', 'Build a new index from the transcripts instead of updating in place')
  .option('--prune', 'Remove sessions whose transcripts are no longer on disk')
  .option('--status', 'Show the index and what changed locally since the last sync')
  .option('--drop', 'Delete the index, including its labels')
  .option('--dry-run', 'Read and count sessions without indexing them')
  .option('--json', 'Output JSON')
  .addHelpText('after', `
Sync is incremental: only sessions whose transcript changed are re-read, and
their fields are merged into the existing documents. Anything else stored on a
document (labels, notes, fields an agent added) is left alone.

The index is <index>-YYYYMMDD-HHMMSS behind the <index> alias. --rebuild writes
a new one, carries labels and notes over, and swaps the alias when it is done.`)
  .action(runSync);

program
  .command('label <session-id> [labels...]')
  .description('Show or set labels on an indexed session (key=value ...)')
  .option('--remove <key>', 'Remove a label (repeatable)', collectOption)
  .option('--message <seq>', 'Label one message, by the position search reports', parseSeq)
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .addHelpText('after', `
Labels are free-form classification stored in Elasticsearch. They survive
every sync and rebuild, and search can filter on them:
  sessions label a1b2c3d4 client=acme topic=billing,invoices
  sessions search "refund" --label client=acme
  sessions label a1b2c3d4 --remove topic`)
  .action(runLabel);

program
  .command('labels')
  .description('List label keys and values with how many sessions carry them')
  .option('--json', 'Output JSON')
  .action(runLabels);

program.parse();
