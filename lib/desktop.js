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
//   <app data>/local-agent-mode-sessions/<account>/<org>/<folder>/
// with the transcript inside it under .claude/projects/<folder>/<id>.jsonl,
// and its record beside the folder, at local_<uuid>.json. The folder is named
// like the record or, by newer versions of the app, with only the first
// eight characters of the uuid. Nothing outside the app looks there unless
// told to.
//
// A Cowork storage folder can hold more than one transcript. The record
// names the session's own (cliSessionId, and previousCliSessionIds for the
// ones it had before); the title belongs to those.
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

// The app does not always call its data folder "Claude". It keeps a second
// one, "Claude-3p", for when it is set up to run on another provider. On
// Windows there is a third, "Claude-Data", for a profile that cannot stay in
// the roaming folder. Which of them holds sessions depends on how the app
// was installed and set up, so every one that exists is read.
const DATA_FOLDER = 'Claude';
const PROVIDER_DATA_FOLDER = 'Claude-3p';
const WINDOWS_DATA_FOLDER = 'Claude-Data';
// A Windows install that comes as a package keeps its own copy of each of
// those folders inside the package. Once it has moved its data out of the
// package, the data is in a folder of its own inside Claude-Data, named
// after the package in lower case.
const WINDOWS_PACKAGES = ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t'];

// Where the app keeps its data on this platform, in the app's own order.
function standardDataDirs(env, home, platform) {
  if (platform === 'win32') {
    const roaming = env.APPDATA;
    const local = env.LOCALAPPDATA;
    const dirs = [];
    for (const [base, kind, name] of [
      [roaming, 'Roaming', DATA_FOLDER],
      [local, 'Local', DATA_FOLDER],
      [local, 'Local', WINDOWS_DATA_FOLDER],
      [local, 'Local', PROVIDER_DATA_FOLDER],
      [roaming, 'Roaming', PROVIDER_DATA_FOLDER]
    ]) {
      if (base) dirs.push(path.join(base, name));
      if (base && name === WINDOWS_DATA_FOLDER) for (const pkg of WINDOWS_PACKAGES) dirs.push(path.join(base, name, pkg.toLowerCase()));
      if (local) for (const pkg of WINDOWS_PACKAGES) dirs.push(path.join(local, 'Packages', pkg, 'LocalCache', kind, name));
    }
    return dirs;
  }
  const base = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(base, DATA_FOLDER), path.join(base, PROVIDER_DATA_FOLDER)];
}

// Whether the usual folders, and the ones the config file adds to them, are
// read at all. SESSIONS_CLAUDE_DESKTOP_DIR names the one folder to read
// instead (empty turns the app off). When SESSIONS_CLAUDE_DIR moves the
// Claude directory, as tests do, the app data of this machine is left alone
// unless it is named that way too.
export function readsUsualDesktopDirs(env = process.env) {
  return env.SESSIONS_CLAUDE_DESKTOP_DIR === undefined && !env.SESSIONS_CLAUDE_DIR;
}

// The folders the desktop app may keep its data in. Empty when it should not
// be read. `extra` holds the folders the config file adds to the usual ones.
export function desktopDataDirs(env = process.env, { home = os.homedir(), platform = process.platform, extra = [] } = {}) {
  if (env.SESSIONS_CLAUDE_DESKTOP_DIR !== undefined) return env.SESSIONS_CLAUDE_DESKTOP_DIR ? [env.SESSIONS_CLAUDE_DESKTOP_DIR] : [];
  if (!readsUsualDesktopDirs(env)) return [];
  return [...new Set([...standardDataDirs(env, home, platform), ...extra])];
}

// The folders among those that are named outright, in the environment or in
// the config file, rather than looked in because the app usually keeps its
// data there. A usual folder is often absent and that says nothing. A named
// one is expected to be there and to be the app's, and that holds for a
// usual folder too once the config file names it: whoever wrote it down
// expects sessions there.
export function namedDesktopDirs(env = process.env, { extra = [] } = {}) {
  if (env.SESSIONS_CLAUDE_DESKTOP_DIR !== undefined) return env.SESSIONS_CLAUDE_DESKTOP_DIR ? [env.SESSIONS_CLAUDE_DESKTOP_DIR] : [];
  if (!readsUsualDesktopDirs(env)) return [];
  return [...new Set(extra)];
}

// The app's own settings file, which only its data folder has by that name.
const APP_SETTINGS = 'claude_desktop_config.json';

// Why a folder that was named outright cannot be relied on, or null when it
// can: it is not found, it cannot be looked into, or it holds no sessions of
// the app. Only a folder where the app keeps sessions shows that it is the
// right one. One without any is the wrong folder as far as can be told (a
// mistyped path, another profile, the place a drive is mounted at while the
// drive is away), and the sessions that should be in it are missing, not
// deleted.
export async function namedFolderTrouble(dataDir) {
  try {
    if (!(await fs.stat(dataDir)).isDirectory()) return 'not a folder';
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'not found' : error.code || error.message;
  }
  let refused = null;
  const there = async name => {
    try {
      return await fs.stat(path.join(dataDir, name));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') refused ||= error.code || error.message;
      return null;
    }
  };
  for (const name of [CODE_SESSIONS, COWORK_SESSIONS]) {
    if ((await there(name))?.isDirectory()) return null;
  }
  const ofApp = Boolean(await there(APP_SETTINGS));
  return refused || (ofApp ? 'no sessions of the Claude desktop app in it' : 'not a data folder of the Claude desktop app');
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
  const transcriptId = text(data.cliSessionId);
  const earlier = Array.isArray(data.previousCliSessionIds) ? data.previousCliSessionIds.map(text).filter(Boolean) : [];
  return {
    desktopId: text(data.sessionId),
    transcriptId,
    // Every transcript the session has had, its current one first.
    transcriptIds: [...new Set([transcriptId, ...earlier].filter(Boolean))],
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

// The id the app gives a session, which is also the name of its record. The
// first eight characters of the uuid are what newer versions of the app name
// the storage folder.
const SESSION_ID = /^local_([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A link stands for what it points at: a record or a transcript that is one
// is read through it, as a folder that could not be opened reads as empty.
const fileOrLink = entry => entry.isFile() || entry.isSymbolicLink();
const folderOrLink = entry => entry.isDirectory() || entry.isSymbolicLink();

// The ids of the transcripts kept under one "projects" folder.
async function transcriptIdsIn(projectsDir) {
  const ids = new Set();
  for (const project of await entriesOf(projectsDir)) {
    if (!folderOrLink(project)) continue;
    for (const file of await entriesOf(path.join(projectsDir, project.name))) {
      if (fileOrLink(file) && file.name.endsWith('.jsonl')) ids.add(file.name.slice(0, -'.jsonl'.length));
    }
  }
  return ids;
}

// Whether a Cowork storage folder holds any transcript at all.
export async function holdsATranscript(projectsDir) {
  return (await transcriptIdsIn(projectsDir)).size > 0;
}

// Gives each storage folder found in one directory the record of its
// session. The record sits beside the folder. It is found by name first, the
// way the app names the two. A folder that no record answers to by name is
// then matched by the transcripts a record lists, so a folder named some
// other way is still paired with its session. A folder left without a record
// is still a session: it has no title and counts as Cowork.
async function pairWithRecords(dir, entries, folders) {
  const stems = entries
    .filter(entry => fileOrLink(entry) && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -'.json'.length))
    .sort();
  const records = new Map();
  const recordOf = async stem => {
    if (!records.has(stem)) records.set(stem, desktopRecord(await readJson(path.join(dir, `${stem}.json`)), 'cowork'));
    return records.get(stem);
  };
  const transcripts = new Map();
  const holds = async (folder, record) => {
    if (record.transcriptIds.length === 0) return false;
    if (!transcripts.has(folder)) transcripts.set(folder, await transcriptIdsIn(folder.projectsDir));
    const ids = transcripts.get(folder);
    return record.transcriptIds.some(id => ids.has(id));
  };

  // What each record could be the record of: a folder of its own name, and
  // for a session id a folder named with its first eight characters.
  const exact = new Set(stems);
  const byShortForm = new Map();
  for (const stem of stems) {
    const short = SESSION_ID.exec(stem)?.[1].toLowerCase();
    if (short) byShortForm.set(short, [...(byShortForm.get(short) || []), stem]);
  }

  const unpaired = [];
  for (const folder of folders) {
    const names = new Set([...(exact.has(folder.name) ? [folder.name] : []), ...(byShortForm.get(folder.name.toLowerCase()) || [])]);
    const candidates = [];
    for (const stem of names) {
      const record = await recordOf(stem);
      if (!record) continue;
      // A session's record says which session it is: in what it holds or,
      // failing that, by being named with a session's id. A file that does
      // neither is not one, whatever folder it is called like.
      if (!record.desktopId && SESSION_ID.test(stem)) record.desktopId = stem;
      if (!record.desktopId && record.transcriptIds.length === 0) continue;
      // Eight characters are not a name: another session can begin with
      // them, and its record can outlive this folder's own. A record that
      // says which transcripts are its session's has to find one here.
      if (stem !== folder.name && record.transcriptIds.length > 0 && !await holds(folder, record)) continue;
      candidates.push({ stem, record });
    }
    // More than one record can answer to a folder's name: two sessions that
    // begin with the same eight characters, or a file that happens to be
    // called what the folder is. The folder belongs to the one whose
    // transcript it holds and, failing that, to its exact namesake.
    let match = candidates.length === 1 ? candidates[0] : null;
    if (candidates.length > 1) {
      const holding = [];
      for (const candidate of candidates) {
        if (await holds(folder, candidate.record)) holding.push(candidate);
      }
      match = holding.length === 1 ? holding[0] : candidates.find(candidate => candidate.stem === folder.name) || null;
    }
    if (match) {
      folder.record = match.record;
    } else {
      unpaired.push(folder);
    }
  }

  // Which records list which transcript, worked out once and only when a
  // folder is still without one. A record that a folder already answers to
  // by name counts too: a session's earlier transcript can sit in a folder
  // of its own, and it is still that session's. Of several records that
  // list a folder's transcripts, the first by name is taken, so the answer
  // does not depend on the order a directory happens to be read in.
  if (unpaired.length > 0) {
    const lists = new Map();
    for (const stem of stems) {
      if (!stem.startsWith('local_')) continue;
      const record = await recordOf(stem);
      for (const id of record?.transcriptIds || []) lists.set(id, [...(lists.get(id) || []), stem]);
    }
    for (const folder of unpaired) {
      if (lists.size === 0) break;
      if (!transcripts.has(folder)) transcripts.set(folder, await transcriptIdsIn(folder.projectsDir));
      const listing = [...transcripts.get(folder)].flatMap(id => lists.get(id) || []).sort();
      if (listing.length > 0) folder.record = records.get(listing[0]);
    }
  }

  return folders.map(folder => ({
    storageDir: folder.storageDir,
    projectsDir: folder.projectsDir,
    record: folder.record || desktopRecord({}, 'cowork')
  }));
}

// Cowork sessions: every storage folder that holds transcripts, with its
// record. The folder is found by what it contains rather than by how deep it
// sits or what it is called, so a change in the nesting above it or in its
// name does not hide sessions.
export async function findCoworkSessions(dataDir, problems = []) {
  const found = [];
  const pending = [{ dir: path.join(dataDir, COWORK_SESSIONS), depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop();
    const entries = await entriesOf(dir, problems);
    const folders = [];
    for (const entry of entries) {
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
        folders.push({ name: entry.name, storageDir: full, projectsDir });
      } else if (depth < MAX_DEPTH) {
        pending.push({ dir: full, depth: depth + 1 });
      }
    }
    if (folders.length > 0) found.push(...await pairWithRecords(dir, entries, folders));
  }
  return found.sort((a, b) => a.storageDir.localeCompare(b.storageDir));
}

// How a desktop session is marked wherever a session is named.
export function desktopNote(session) {
  if (session?.app !== 'desktop') return '';
  return session.desktopKind && session.desktopKind !== 'code' ? `(desktop ${session.desktopKind})` : '(desktop)';
}
