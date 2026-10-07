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
        if (isModern && entry.startsWith('session_')) {
          sessionId = entry.slice('session_'.length);
          transcriptPath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
          format = 'wire';
          project = null;
          try {
            const state = JSON.parse(await fs.readFile(path.join(sessionDir, 'state.json'), 'utf8'));
            project = state.workDir || null;
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
  const match = text.trim().match(/^<([a-z_]+)>[\s\S]*<\/\1>$/);
  return match ? [
    'environment_context', 'turn_aborted',
    'external_codex_apps_open_page', 'recommended_plugins'
  ].includes(match[1]) : false;
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

async function streamSessionMessages(session, callback) {
  if (session.source === 'claude') {
    await streamLines(session.filePath, (data) => {
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

async function getSessionMeta(session) {
  let firstPrompt = null;
  let timestamp = null;
  let userCount = 0;
  let assistantCount = 0;
  let model = null;

  await streamSessionMessages(session, (data) => {
    if (data.type === 'user') {
      userCount++;
      if (!firstPrompt) {
        const text = extractTextContent(data.message?.content);
        if (text) firstPrompt = text;
        if (data.timestamp) timestamp = data.timestamp;
      }
    } else if (data.type === 'assistant') {
      assistantCount++;
      if (!model && data.message?.model) model = data.message.model;
    }
  });

  return { firstPrompt, timestamp, userCount, assistantCount, model, messageCount: userCount + assistantCount };
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
    const header = c.bold.cyan('\u25b6 You') + c.dim(` ${ts}`);
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

    const header = c.bold.green(`\u25c0 ${speakerName(msg.source)}`) + c.dim(` (${modelName}) ${ts}`);
    return header + '\n' + parts.join('\n');
  }

  return null;
}

program
  .name('sessions')
  .description('Search and browse Claude Code, Codex, and Kimi session transcripts')
  .version(pkg.version);

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
  .option('--json', 'Output JSON')
  .action(async (query, opts) => {
    let sessions = await getSessionFiles(opts.project, opts.source);
    const limit = parseInt(opts.limit);
    const contextN = parseInt(opts.context);
    const lowerQuery = query.toLowerCase();
    const results = [];
    const sessionMatchCounts = new Map();
    const sessionTotalCounts = new Map();

    const since = opts.days ? daysToSinceDate(parseInt(opts.days)) : opts.since ? new Date(opts.since) : null;
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
        const text = extractTextContent(data.message?.content);
        if (!text || !text.toLowerCase().includes(lowerQuery)) continue;

        totalHits++;
        const key = sessionKey(session);
        const count = sessionMatchCounts.get(key) || 0;
        sessionMatchCounts.set(key, count + 1);

        const cleaned = cleanSnippet(text);
        const lines = cleaned.split('\n').filter(l => l.trim());
        const matchLines = [];
        const seen = new Set();
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length - 1, i + 1);
            const snippet = [];
            for (let j = start; j <= end; j++) {
              if (seen.has(j)) continue;
              seen.add(j);
              let l = lines[j];
              if (l.length > 200) l = l.slice(0, 200) + '\u2026';
              if (j === i) {
                l = l.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                  m => c.bold.yellow(m));
              }
              snippet.push(l);
            }
            if (snippet.length > 0) matchLines.push(snippet.join('\n'));
          }
        }

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
      const time = r.timestamp ? formatRelativeTime(r.timestamp) : '';
      const who = r.type === 'user' ? c.cyan('you') : c.green(r.source);
      const totalInSession = sessionTotalCounts.get(sessionKey(r)) || 0;
      const hits = totalInSession > 1 ? c.dim(` (${totalInSession} matches in session)`) : '';
      console.log(
        c.yellow(r.shortId) + ' ' +
        sourceTag(r.source) + ' ' +
        c.dim(r.project) + ' ' +
        who + ' ' +
        c.dim(time) +
        hits
      );
      if (r.contextMessages) {
        for (const ctx of r.contextMessages.filter(m => m.position === 'before')) {
          const ctxWho = ctx.type === 'user' ? c.dim.cyan('  [you]') : c.dim.green(`  [${r.source}]`);
          console.log(ctxWho + c.dim(` ${ctx.text}`));
        }
      }
      for (const snippet of r.snippets) {
        console.log('  ' + snippet.split('\n').map(l => '  ' + l).join('\n'));
      }
      if (r.contextMessages) {
        for (const ctx of r.contextMessages.filter(m => m.position === 'after')) {
          const ctxWho = ctx.type === 'user' ? c.dim.cyan('  [you]') : c.dim.green(`  [${r.source}]`);
          console.log(ctxWho + c.dim(` ${ctx.text}`));
        }
      }
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
        if (prompts.length > 0) {
          console.log(c.dim('  --- session prompts ---'));
          for (const p of prompts) {
            console.log(c.dim(`    ${p.time}`) + `  ${p.text}`);
          }
        }
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

program.parse();
