// Sessions of the Claude desktop app.
//
// The app runs Claude Code underneath, so its transcripts are ordinary Claude
// Code transcripts. What differs is where they are kept and what the app
// knows about them:
//
// Code tab. The transcript is where the terminal CLI would put it, under
// ~/.claude/projects, so it is read like any other. The app adds a record at
//   <app data>/claude-code-sessions/<account>/<org>/local_<id>.json
// that names the transcript (cliSessionId) and holds the title shown in the
// app and whether the session is archived.
//
// Cowork tab. Each session has a storage folder of its own,
//   <app data>/local-agent-mode-sessions/<account>/<org>/<session>/
// with the transcript inside it under .claude/projects/<folder>/<id>.jsonl,
// and its record beside the folder, at <session>.json. Nothing outside the
// app looks there unless told to.
//
// A Cowork storage folder can hold more than one transcript. The record
// names the session's own (cliSessionId); the title belongs to that one.
//
// Chats (the Chat tab) are kept by claude.ai, not on this machine.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CODE_SESSIONS = 'claude-code-sessions';
const COWORK_SESSIONS = 'local-agent-mode-sessions';
// Under the Cowork folder these hold plugins, caches and files, not sessions.
const NOT_SESSIONS = new Set(['skills-plugin', 'plugin-cache', 'rpm', 'cowork_plugins', 'remote_cowork_plugins', 'uploads', 'outputs']);
const MAX_DEPTH = 4;

// The Windows build installed from the Microsoft Store keeps its profile
// inside its package instead of in %APPDATA%.
const WINDOWS_PACKAGE = 'Claude_pzs8sxrjxfjjc';

// The folders the desktop app may keep its data in, likeliest first. Empty
// when it should not be read. SESSIONS_CLAUDE_DESKTOP_DIR names the folder
// outright (empty turns it off). When SESSIONS_CLAUDE_DIR moves the Claude
// directory, as tests do, the real app data is left alone unless it is named
// too.
export function desktopDataDirs(env = process.env, { home = os.homedir(), platform = process.platform } = {}) {
  if (env.SESSIONS_CLAUDE_DESKTOP_DIR !== undefined) return env.SESSIONS_CLAUDE_DESKTOP_DIR ? [env.SESSIONS_CLAUDE_DESKTOP_DIR] : [];
  if (env.SESSIONS_CLAUDE_DIR) return [];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude')];
  if (platform === 'win32') {
    const dirs = [];
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'Claude'));
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Packages', WINDOWS_PACKAGE, 'LocalCache', 'Roaming', 'Claude'));
    return dirs;
  }
  return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')];
}

// The first of those folders, or null.
export function desktopDataDir(env = process.env, where = {}) {
  return desktopDataDirs(env, where)[0] || null;
}

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

function moment(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// What this tool keeps of one of the app's session records.
//   kind: 'code' for the Code tab; for Cowork 'cowork', 'chat' or 'scheduled'
export function desktopRecord(data, tab) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const type = text(data.sessionType);
  const kind = tab === 'code' ? 'code' : type === 'chat' || type === 'scheduled' ? type : 'cowork';
  return {
    desktopId: text(data.sessionId),
    transcriptId: text(data.cliSessionId),
    title: text(data.title),
    kind,
    archived: data.isArchived === true,
    cwd: text(data.cwd) || text(data.originCwd),
    folders: Array.isArray(data.userSelectedFolders) ? data.userSelectedFolders.map(text).filter(Boolean) : [],
    createdAt: moment(data.createdAt),
    lastActivityAt: moment(data.lastActivityAt),
    transcriptOnDisk: data.transcriptUnavailable !== true
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// A folder that is not there holds nothing. One that is there and cannot be
// read is added to `problems`: whatever sessions it holds are missing from
// the answer, and the caller has to be able to say so.
async function entriesOf(dir, problems) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') problems?.push({ path: dir, reason: error.code || error.message });
    return [];
  }
}

// Code tab records, by the id of the transcript each one belongs to.
export async function readCodeRecords(dataDir, problems = []) {
  const records = new Map();
  const pending = [{ dir: path.join(dataDir, CODE_SESSIONS), depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop();
    for (const entry of await entriesOf(dir, problems)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) pending.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && /^local_.+\.json$/.test(entry.name)) {
        const record = desktopRecord(await readJson(full), 'code');
        if (!record?.transcriptId) continue;
        // A transcript resumed under a new record keeps the newer one.
        const known = records.get(record.transcriptId);
        if (!known || (record.lastActivityAt || 0) >= (known.lastActivityAt || 0)) records.set(record.transcriptId, record);
      }
    }
  }
  return records;
}

// Cowork sessions: every storage folder that holds transcripts, with its
// record. The folder is found by what it contains rather than by how deep it
// sits, so a change in the nesting above it does not hide sessions.
export async function findCoworkSessions(dataDir, problems = []) {
  const found = [];
  const pending = [{ dir: path.join(dataDir, COWORK_SESSIONS), depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop();
    for (const entry of await entriesOf(dir, problems)) {
      if (!entry.isDirectory() || NOT_SESSIONS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const projectsDir = path.join(full, '.claude', 'projects');
      let stat = null;
      try {
        stat = await fs.stat(projectsDir);
      } catch (error) {
        // Not there is the usual answer: most folders here are not sessions.
        // A folder that cannot be looked into may well be one.
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
          problems.push({ path: full, reason: error.code || error.message });
          continue;
        }
      }
      if (stat?.isDirectory()) {
        found.push({
          storageDir: full,
          projectsDir,
          record: desktopRecord(await readJson(`${full}.json`), 'cowork') || desktopRecord({}, 'cowork')
        });
      } else if (depth < MAX_DEPTH) {
        pending.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return found.sort((a, b) => a.storageDir.localeCompare(b.storageDir));
}

// How a desktop session is marked wherever a session is named.
export function desktopNote(session) {
  if (session?.app !== 'desktop') return '';
  return session.desktopKind && session.desktopKind !== 'code' ? `(desktop ${session.desktopKind})` : '(desktop)';
}
