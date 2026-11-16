#!/usr/bin/env node

import { InvalidArgumentError, program } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { displayUrl, isLoopbackUrl, isValidIndexName, loadConfig } from './config.js';

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

async function streamLines(filePath, callback) {
  const stream = createReadStream(filePath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const stop = callback(data);
        if (stop === true) break;
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function resolveClaudeProjectPath(encodedDir) {
  const projectDir = path.join(PROJECTS_DIR, encodedDir);
  const files = await fs.readdir(projectDir);
  const firstSession = files.find(f => f.endsWith('.jsonl'));
  if (!firstSession) return encodedDir;

  let cwd = null;
  await streamLines(path.join(projectDir, firstSession), (data) => {
    if (data.cwd) { cwd = data.cwd; return true; }
  });
  return cwd || encodedDir;
}

async function getClaudeProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const entries = await fs.readdir(PROJECTS_DIR);
  const projects = [];

  for (const entry of entries) {
    const projectDir = path.join(PROJECTS_DIR, entry);
    const stat = await fs.stat(projectDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const files = await fs.readdir(projectDir);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
    if (sessionFiles.length === 0) continue;

    let totalSize = 0;
    for (const file of sessionFiles) {
      const s = await fs.stat(path.join(projectDir, file)).catch(() => null);
      if (s) totalSize += s.size;
    }

    const decoded = await resolveClaudeProjectPath(entry);

    projects.push({
      encoded: entry,
      path: decoded,
      source: 'claude',
      sessionCount: sessionFiles.length,
      totalSize
    });
  }

  return projects.sort((a, b) => a.path.localeCompare(b.path));
}

function makeShortId(source, sessionId) {
  const compact = String(sessionId || '').replace(/-/g, '');
  return source === 'codex' ? compact.slice(0, 12) : compact.slice(0, 8);
}

async function getClaudeSessionFiles(projectFilter = null) {
  const projects = await getClaudeProjects();
  const sessions = [];

  for (const project of projects) {
    if (projectFilter) {
      const pf = projectFilter.toLowerCase();
      const matchesDecoded = project.path.toLowerCase().includes(pf);
      const matchesEncoded = project.encoded.toLowerCase().includes(pf);
      if (!matchesDecoded && !matchesEncoded) continue;
    }

    const projectDir = path.join(PROJECTS_DIR, project.encoded);
    const files = await fs.readdir(projectDir);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const file of sessionFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;

      sessions.push({
        sessionId,
        shortId: makeShortId('claude', sessionId),
        source: 'claude',
        project: project.path,
        projectEncoded: project.encoded,
        filePath,
        size: stat.size,
        modifiedAt: stat.mtime
      });
    }
  }

  return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function findJsonlFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }

  return files;
}

function sessionIdFromCodexFilename(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
  return match ? match[1] : path.basename(filePath, '.jsonl').replace(/^rollout-[^-]+-/, '');
}

async function getCodexSessionDescriptor(filePath, archived = false) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;

  const filenameSessionId = sessionIdFromCodexFilename(filePath);
  let sessionId = null;
  let project = null;
  let startedAt = null;
  await streamLines(filePath, (data) => {
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
    }
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

async function getCodexSessionFiles(projectFilter = null) {
  const activeFiles = await findJsonlFiles(CODEX_SESSIONS_DIR);
  const archivedFiles = await findJsonlFiles(CODEX_ARCHIVED_SESSIONS_DIR);
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
    const buckets = await fs.readdir(sessionsRoot).catch(() => []);

    for (const bucket of buckets) {
      const bucketDir = path.join(sessionsRoot, bucket);
      const bucketStat = await fs.stat(bucketDir).catch(() => null);
      if (!bucketStat || !bucketStat.isDirectory()) continue;
      const isModern = bucket.startsWith('wd_');
      let legacyProject = null;
      const entries = await fs.readdir(bucketDir).catch(() => []);

      for (const entry of entries) {
        const sessionDir = path.join(bucketDir, entry);
        const sessionStat = await fs.stat(sessionDir).catch(() => null);
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
            title = state.title || null;
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

        const stat = await fs.stat(transcriptPath).catch(() => null);
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


async function getSessionFiles(projectFilter = null, source = 'all') {
  const selected = parseSource(source);
  const include = (name) => selected === 'all' || selected === name;
  const groups = await Promise.all([
    include('claude') ? getClaudeSessionFiles(projectFilter) : [],
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

  const combined = [
    ...claudeProjects,
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
  });
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
    const header = c.bold.cyan('\u25b6 You') + c.dim(` ${ts}`) + (opts.tag || '');
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
  if (r.injected) return c.dim('system');
  return r.type === 'user' ? c.cyan('you') : c.green(r.source);
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

function elasticSnippets(hit, query, mode, elastic) {
  if (mode === 'literal') {
    const literal = hit.text ? literalSnippets(hit.text, query).slice(0, 2) : [];
    if (literal.length > 0) return literal;
  }
  const paint = fragment => paintFragment(fragment, elastic.HIGHLIGHT_OPEN, elastic.HIGHLIGHT_CLOSE);
  const snippets = hit.fragments.slice(0, 2).map(paint);
  if (hit.toolFragments.length > 0) {
    const label = hit.tools.length > 0 ? hit.tools.join(', ') : 'tool';
    snippets.push(c.dim(`\u{1f527} ${label}: `) + paint(hit.toolFragments[0]));
  }
  if (snippets.length === 0 && hit.preview) snippets.push(hit.preview);
  return snippets;
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
  const hint = ageMs > 60 * 60_000 ? '; run "sessions sync" to include newer messages' : '';
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
async function refreshIfStale(elastic, client, config, snapshot) {
  const es = config.elasticsearch;
  if (!es.autoSyncMinutes || !snapshot.syncedAt) return snapshot;
  if (Date.now() - snapshot.syncedAt.getTime() < es.autoSyncMinutes * 60_000) return snapshot;
  if (snapshot.meta?.schema !== elastic.SCHEMA_VERSION) return snapshot;
  if (!isLoopbackUrl(es.url) && !es.allowRemote) return snapshot;
  try {
    const everything = await getSessionFiles(null, 'all');
    await elastic.syncIndex({
      client,
      alias: es.index,
      keep: es.keep,
      sessions: everything,
      allSessionKeys: everything.map(sessionKey),
      reader: { streamSessionMessages, extractTextContent, isDisplayPrompt },
      scope: { source: 'all', project: null, since: null },
      toolVersion: pkg.version
    });
    return (await elastic.currentSnapshot(client, es.index)) || snapshot;
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

// Returns true when the search was answered, or a reason it could not be.
async function runElasticSearch(query, opts, config) {
  const elastic = await import('./elastic.js');
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

  // -n caps the matches shown, as it does when scanning files. Sessions come
  // best first and each contributes up to --per-session matches.
  const hits = result.groups.flatMap(group => group.hits.map(hit => ({ hit, group }))).slice(0, limit);
  const shownSessions = new Set(hits.map(({ hit }) => hit.sessionKey));
  const [context, sessionLabels] = await Promise.all([
    elastic.fetchContext(client, snapshot.index, hits.map(({ hit }) => hit), contextN),
    elastic.getLabels(client, snapshot.index, [...shownSessions])
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
      snippets: elasticSnippets(hit, query, result.mode, elastic),
      contextMessages: (context.get(`${hit.sessionKey}:${hit.seq}`) || []).map(message => ({ ...message, text: truncate(message.text, 150) })),
      score: hit.score,
      matchesInSession: group.matchesInSession,
      matchMode: result.mode,
      seq: hit.seq,
      tools: hit.tools,
      _sessionKey: hit.sessionKey
    };
    if (hit.injected) row.injected = true;
    // Label fields appear only when something is labeled.
    const ofSession = sessionLabels.get(hit.sessionKey);
    if (ofSession) row.sessionLabels = ofSession;
    if (hit.labels) row.labels = hit.labels;
    return row;
  });

  if (opts.json) {
    console.log(JSON.stringify(rows.map(({ _sessionKey, ...rest }) => rest), null, 2));
    return true;
  }

  if (rows.length === 0) {
    console.log(inSession ? `No matches for "${query}" in ${inSession.shortId}.` : `No matches for "${query}".`);
    console.log(c.dim(snapshotFooter(snapshot)));
    return true;
  }

  if (inSession) {
    const shown = rows.length < result.totalMessages ? c.dim(` (showing ${rows.length})`) : '';
    console.log(c.bold(`${plural(result.totalMessages, 'match')} in `) + c.yellow(inSession.shortId) + ' ' +
      sourceTag(inSession.source) + ' ' + c.dim(inSession.project) + shown);
  } else {
    const shown = shownSessions.size < result.totalSessions ? c.dim(` (showing ${shownSessions.size})`) : '';
    console.log(c.bold(`${plural(result.totalMessages, 'match')} in ${plural(result.totalSessions, 'session')}`) + shown);
  }
  if (!opts.literal && SEARCH_MODE_NOTES[result.mode]) console.log(c.dim(SEARCH_MODE_NOTES[result.mode]));

  const prompts = opts.preview
    ? await elastic.fetchPrompts(client, snapshot.index, [...shownSessions])
    : new Map();
  const previewShown = new Set();
  const spaced = contextN > 0 || Boolean(opts.preview);
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
      printSessionPrompts((prompts.get(row._sessionKey) || []).map(p => ({
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
    if (shownSessions.size < result.totalSessions) printFacets(result.facets);
    console.log(c.dim(`Drill in: add --session ${top.shortId} for every match in that session, or run: sessions show ${top.shortId} --around ${top.seq}`));
  }
  console.log(c.dim(snapshotFooter(snapshot)));
  return true;
}

// Decides which backend answers a search. Returns true when Elasticsearch
// handled it; false means the caller should scan session files.
async function searchWithElasticsearch(query, opts) {
  const config = await loadConfig({ overrides: { backend: opts.local ? 'local' : undefined } });
  if (config.warning) console.error(c.yellow(config.warning));
  const es = config.elasticsearch;
  const backend = config.search.backend;
  const needsElastic = Boolean(opts.tools || opts.tool || opts.label?.length || opts.session);
  const useElastic = backend === 'elasticsearch' || (backend === 'auto' && Boolean(es.url));

  if (!useElastic) {
    if (needsElastic) {
      console.error(c.red(es.url
        ? '--tools, --tool, --label and --session need the Elasticsearch index, and this search is set to scan files (--local or search.backend: local).'
        : '--tools, --tool, --label and --session use the optional Elasticsearch index. Run "sessions sync" to set one up.'));
      process.exit(1);
    }
    return false;
  }

  let failure;
  if (!es.url) {
    failure = 'No Elasticsearch URL is configured (set SESSIONS_ES_URL or elasticsearch.url in ~/.sessions/config.yaml)';
  } else {
    try {
      const outcome = await runElasticSearch(query, opts, config);
      if (outcome === true) return true;
      failure = outcome;
    } catch (error) {
      if (error.name !== 'ElasticError') throw error;
      failure = error.message;
    }
  }

  if (backend === 'elasticsearch' || needsElastic) {
    console.error(c.red(failure));
    process.exit(1);
  }
  console.error(c.dim(`${failure}. Scanning session files instead.`));
  return false;
}

const LOCAL_ES_COMMAND = 'docker run -d --name sessions-es -p 127.0.0.1:9220:9200 ' +
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
    const local = await getSessionFiles(null, 'all');
    [pending, labels] = await Promise.all([
      elastic.indexedSessions(client, details.index).then(indexed => elastic.compareWithIndex(local, indexed)),
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
  if (waiting > 0) parts.push(`${pending.changed} changed, ${pending.added} new ${c.dim('(run "sessions sync")')}`);
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

  const elastic = await import('./elastic.js');
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

    const everything = await getSessionFiles(null, 'all');
    const since = sinceFromOptions(opts);
    let sessions = opts.project || opts.source !== 'all' ? await getSessionFiles(opts.project, opts.source) : everything;
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
  const elastic = await import('./elastic.js');
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

    const sessions = await getSessionFiles(null, opts.source);
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

if (process.argv[2] === '--serve') process.argv[2] = 'serve';

program
  .name('sessions')
  .description('Search and browse Claude Code, Codex, and Kimi session transcripts')
  .version(pkg.version)
  .option('--serve', 'Start the local web dashboard (alias for serve)');

program
  .command('serve')
  .description('Serve a live local dashboard of active and past sessions')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option('-p, --port <port>', 'Port to listen on (0 chooses a free port)', parsePort, 4220)
  .option('--active-minutes <minutes>', 'Consider sessions active for this long after updates', parseActiveMinutes, 15)
  .option('--open', 'Open the dashboard in your default browser')
  .action(async (opts) => {
    const { startSessionServer } = await import('./server.js');
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
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    let sessions = await getSessionFiles(opts.project, opts.source);
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
      return;
    }

    console.log(c.bold(`${sessions.length} sessions`) + c.dim(` (showing ${shown.length})\n`));

    for (const s of shown) {
      const meta = opts.full ? await getSessionMeta(s) : await getSessionMetaFast(s);
      const firstLine = meta.firstPrompt ? truncate(meta.firstPrompt, 90) : c.dim('(empty)');
      const time = formatRelativeTime(s.modifiedAt);
      const msgInfo = meta.messageCount ? `${meta.messageCount} msg` : '';

      console.log(
        c.yellow(s.shortId) + ' ' +
        sourceTag(s.source) + ' ' +
        c.dim(s.project) + ' ' +
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
  .option('-n, --limit <n>', 'Max results', '10')
  .option('-C, --context <n>', 'Context messages around match', '0')
  .option('--since <date>', 'Only search sessions modified since date (YYYY-MM-DD)')
  .option('--days <n>', 'Only search sessions from last N days')
  .option('--preview', 'Show first few prompts per matched session')
  .option('--source <source>', 'Session source: all, claude, codex, or kimi', parseSource, 'all')
  .option('--role <role>', 'Only match messages from: user or assistant', parseRole)
  .option('--local', 'Scan session files even when Elasticsearch is configured')
  .option('--json', 'Output JSON')
  .option('--session <id>', '[Elasticsearch] Every match inside one session, in the order it was said')
  .option('--per-session <n>', '[Elasticsearch] Matches shown per session (default: 1)', parseCount)
  .option('--sort <order>', '[Elasticsearch] Result order: relevance or recent', parseSearchSort)
  .option('--tools', '[Elasticsearch] Also search tool calls: commands, file paths, arguments')
  .option('--tool <name>', '[Elasticsearch] Only match messages that called this tool, e.g. Bash')
  .option('--label <key=value>', '[Elasticsearch] Only match labeled sessions or messages (repeatable)', collectOption)
  .option('--literal', '[Elasticsearch] Match the query as an exact substring')
  .addHelpText('after', `
The query is matched as a case-insensitive substring of each message.

Optional: once "sessions sync" has built an Elasticsearch index, search uses
it instead. It lists the best match of each session, then where and when the
rest are, and queries understand:
  deploy staging        messages containing both words, in any form
  "exact phrase"        those words, in that order
  index.js              identifiers and paths match as a unit
  deploy OR release     either word (grep style works too: deploy\\|release)
  deploy NOT staging    exclude messages containing a word
To get closer to a result:
  sessions search "deploy" --session a1b2c3d4     every match in that session
  sessions show a1b2c3d4 --around 42              the conversation around #42`)
  .action(async (query, opts) => {
    if (await searchWithElasticsearch(query, opts)) return;

    let sessions = await getSessionFiles(opts.project, opts.source);
    const limit = parseInt(opts.limit);
    const contextN = parseInt(opts.context);
    const lowerQuery = query.toLowerCase();
    const results = [];
    const sessionMatchCounts = new Map();
    const sessionTotalCounts = new Map();

    const since = sinceFromOptions(opts);
    if (since) {
      sessions = sessions.filter(s => s.modifiedAt >= since);
    }

    for (const session of sessions) {
      if (results.length >= limit * 3) break;

      const allMessages = [];
      await streamSessionMessages(session, (data) => {
        if (data.type === 'user' || data.type === 'assistant') {
          allMessages.push(data);
        }
      });

      let totalHits = 0;
      for (let mi = 0; mi < allMessages.length; mi++) {
        const data = allMessages[mi];
        if (opts.role && data.type !== opts.role) continue;
        const text = extractTextContent(data.message?.content);
        if (!text || !text.toLowerCase().includes(lowerQuery)) continue;

        totalHits++;
        const key = sessionKey(session);
        const count = sessionMatchCounts.get(key) || 0;
        sessionMatchCounts.set(key, count + 1);

        const matchLines = literalSnippets(text, query);

        const contextMessages = [];
        if (contextN > 0) {
          const start = Math.max(0, mi - contextN);
          const end = Math.min(allMessages.length - 1, mi + contextN);
          for (let ci = start; ci <= end; ci++) {
            if (ci === mi) continue;
            const ctxData = allMessages[ci];
            const ctxText = extractTextContent(ctxData.message?.content);
            if (ctxText && ctxText.trim()) {
              contextMessages.push({
                type: ctxData.type,
                text: truncate(ctxText, 150),
                position: ci < mi ? 'before' : 'after'
              });
            }
          }
        }

        results.push({
          sessionId: session.sessionId,
          shortId: session.shortId,
          source: session.source,
          project: session.project,
          timestamp: data.timestamp,
          type: data.type,
          model: data.message?.model,
          snippets: matchLines.slice(0, 2),
          contextMessages,
          _session: session
        });
      }

      if (totalHits > 0) {
        sessionTotalCounts.set(sessionKey(session), totalHits);
      }
    }

    const sorted = results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, limit);

    if (opts.json) {
      console.log(JSON.stringify(sorted.map(({ _session, ...rest }) => rest), null, 2));
      return;
    }

    if (sorted.length === 0) {
      console.log(`No matches for "${query}".`);
      return;
    }

    console.log(c.bold(`${results.length} matches`) + c.dim(` (showing ${sorted.length})\n`));

    const previewShown = new Set();

    for (const r of sorted) {
      printSearchMatch(r, sessionTotalCounts.get(sessionKey(r)) || 0);
      if (opts.preview && !previewShown.has(sessionKey(r))) {
        previewShown.add(sessionKey(r));
        const prompts = [];
        let count = 0;
        await streamSessionMessages(r._session, (data) => {
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
        printSessionPrompts(prompts);
      }
      console.log('');
    }
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
    const sessions = await getSessionFiles(null, opts.source);
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
      const showOpts = { noTools: opts.tools === false };
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

    const showOpts = { noTools: noTools || opts.assistantOnly };
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
    const sessions = await getSessionFiles(null, opts.source);
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
