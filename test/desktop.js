#!/usr/bin/env node

// Tests for sessions of the Claude desktop app: Code tab sessions, which keep
// their transcript where the CLI does and their title in the app's data, and
// Cowork sessions, which keep their transcript in a folder of their own.
// Hermetic: the app's data directory is a temporary one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopDataDir, desktopDataDirs, desktopNote, desktopRecord, findCoworkSessions, readCodeRecords } from '../lib/desktop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-desktop-'));
const claudeDir = path.join(root, 'claude');
// Named apart from "claude": the two are one folder on a case-insensitive disk.
const appDir = path.join(root, 'app-data');
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31mx\x1b[0m ${name}`);
    console.log(`    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`);
  }
}

function write(file, content, ageMs = 60_000) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  const date = new Date(now - ageMs);
  utimesSync(file, date, date);
  return file;
}
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

function turn(type, text, offset, cwd, extra = {}) {
  return {
    type,
    cwd,
    timestamp: iso(offset),
    ...extra,
    message: { role: type, model: type === 'assistant' ? 'claude-test' : undefined, content: [{ type: 'text', text }] }
  };
}

// --- the CLI's own directory ---

const CODE_ID = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';       // started in the app's Code tab
const RENAMED_ID = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';    // a terminal session given a name with /rename
const PLAIN_ID = 'cccccccc-1111-4222-8333-cccccccccccc';      // a terminal session nobody named
const ARCHIVED_ID = 'dddddddd-1111-4222-8333-dddddddddddd';   // archived in the app
const GONE_ID = 'eeeeeeee-1111-4222-8333-eeeeeeeeeeee';       // the app remembers it, the transcript is gone
const projectDir = path.join(claudeDir, 'projects', '-work-app');
const desktopMark = { entrypoint: 'claude-desktop' };

write(path.join(projectDir, `${CODE_ID}.jsonl`), jsonl([
  turn('user', 'what can you do on this computer', -9_000, '/work/app', desktopMark),
  { type: 'custom-title', customTitle: 'Computer abilities overview', sessionId: CODE_ID },
  turn('assistant', 'I can read files, run commands and drive the browser pane.', -8_900, '/work/app', desktopMark)
]), 60_000);
write(path.join(projectDir, `${RENAMED_ID}.jsonl`), jsonl([
  turn('user', 'refactor the invoice exporter', -8_000, '/work/app'),
  turn('assistant', 'Split the exporter into a reader and a writer.', -7_900, '/work/app'),
  { type: 'custom-title', customTitle: 'First name', sessionId: RENAMED_ID },
  { type: 'custom-title', customTitle: 'Exporter cleanup', sessionId: RENAMED_ID }
]), 120_000);
write(path.join(projectDir, `${PLAIN_ID}.jsonl`), jsonl([
  turn('user', 'list the open pull requests', -7_000, '/work/app'),
  turn('assistant', 'There are three open pull requests.', -6_900, '/work/app')
]), 180_000);
write(path.join(projectDir, `${ARCHIVED_ID}.jsonl`), jsonl([
  turn('user', 'draft the release checklist', -6_000, '/work/app', desktopMark),
  turn('assistant', 'Checklist drafted with nine steps.', -5_900, '/work/app', desktopMark)
]), 240_000);

// Names, and where they are kept.
const CLASH_ID = 'ffffffff-1111-4222-8333-ffffffffffff';      // renamed in the app, the transcript still has the old name
const SIDECAR_ID = '12121212-1111-4222-8333-121212121212';    // named only in the file the app leaves beside a transcript
const NEAR_ID = '13131313-1111-4222-8333-131313131313';       // a long transcript renamed near its end
const BURIED_ID = '14141414-1111-4222-8333-141414141414';     // a long transcript named at its start and never again
const MIDDLE_ID = '15151515-1111-4222-8333-151515151515';     // a name in the middle, where Claude Code itself does not look
// More than the 64 KB that are read from the end of a transcript.
const filler = Array.from({ length: 700 }, (_, index) =>
  turn(index % 2 ? 'assistant' : 'user', `filler line ${index} ${'lorem ipsum dolor sit amet '.repeat(4)}`, -50_000 + index, '/work/app'));

write(path.join(projectDir, `${CLASH_ID}.jsonl`), jsonl([
  turn('user', 'rework how billing runs are scheduled', -5_500, '/work/app', desktopMark),
  { type: 'custom-title', customTitle: 'Invoice cleanup', sessionId: CLASH_ID },
  turn('assistant', 'Billing runs now queue per customer.', -5_400, '/work/app', desktopMark)
]), 300_000);
write(path.join(projectDir, `${SIDECAR_ID}.jsonl`), jsonl([
  turn('user', 'profile the import job', -5_300, '/work/app'),
  turn('assistant', 'Most of the time goes to parsing dates.', -5_200, '/work/app')
]), 360_000);
write(path.join(projectDir, SIDECAR_ID, 'custom-title.json'), { customTitle: '  Sidecar kept name ' });
write(path.join(projectDir, `${NEAR_ID}.jsonl`), jsonl([
  ...filler,
  { type: 'custom-title', customTitle: 'Early name', sessionId: NEAR_ID },
  { type: 'custom-title', customTitle: 'Late rename', sessionId: NEAR_ID },
  turn('assistant', 'Renamed as asked.', -100, '/work/app')
]), 420_000);
write(path.join(projectDir, `${BURIED_ID}.jsonl`), jsonl([
  turn('user', 'start of a long session', -60_000, '/work/app'),
  { type: 'custom-title', customTitle: 'Buried name', sessionId: BURIED_ID },
  ...filler
]), 480_000);
write(path.join(projectDir, `${MIDDLE_ID}.jsonl`), jsonl([
  ...filler,
  { type: 'custom-title', customTitle: 'Middle name', sessionId: MIDDLE_ID },
  ...filler
]), 540_000);
const OWN_IDS = [CODE_ID, RENAMED_ID, PLAIN_ID, ARCHIVED_ID, CLASH_ID, SIDECAR_ID, NEAR_ID, BURIED_ID, MIDDLE_ID];

// --- the desktop app's data ---

const account = path.join('11111111-aaaa-4bbb-8ccc-222222222222', '33333333-aaaa-4bbb-8ccc-444444444444');
const codeRecords = path.join(appDir, 'claude-code-sessions', account);
write(path.join(codeRecords, 'local_code1.json'), {
  sessionId: 'local_code1', cliSessionId: CODE_ID, cwd: '/work/app', originCwd: '/work/app',
  createdAt: now - 9_000, lastActivityAt: now - 8_900, model: 'claude-test', isArchived: false,
  title: 'Computer abilities overview', titleSource: 'auto', completedTurns: 1
});
write(path.join(codeRecords, 'local_code2.json'), {
  sessionId: 'local_code2', cliSessionId: ARCHIVED_ID, cwd: '/work/app', createdAt: now - 6_000, lastActivityAt: now - 5_900,
  isArchived: true, title: 'Release checklist'
});
write(path.join(codeRecords, 'local_code3.json'), {
  sessionId: 'local_code3', cliSessionId: GONE_ID, cwd: '/work/app', createdAt: now - 99_000, lastActivityAt: now - 98_000,
  title: 'Research that is no longer on disk', transcriptUnavailable: true
});
write(path.join(codeRecords, 'local_code4.json'), {
  sessionId: 'local_code4', cliSessionId: CLASH_ID, cwd: '/work/app', createdAt: now - 5_500, lastActivityAt: now - 5_400,
  title: 'Billing rework', titleSource: 'user'
});
write(path.join(codeRecords, 'scheduled-tasks.json'), { scheduledTasks: [] });
write(path.join(codeRecords, 'local_broken.json'), '{ not json');

const COWORK_ID = '99999999-1111-4222-8333-aaaaaaaaaaaa';
const COWORK_CHAT_ID = '99999999-2222-4222-8333-bbbbbbbbbbbb';
const COWORK_DEEP_ID = '99999999-3333-4222-8333-cccccccccccc';
const COWORK_AGENT = 'a7777777777777777';
const COWORK_SIDE_ID = '99999999-4444-4222-8333-dddddddddddd';   // a second transcript in the first session's storage folder
const COWORK_SOLO_ID = '99999999-5555-4222-8333-eeeeeeeeeeee';   // its record does not say which transcript is its own
const COWORK_TWIN_A = '99999999-6666-4222-8333-ffffffffffff';    // nor does this one's, and it holds two
const COWORK_TWIN_B = '99999999-7777-4222-8333-aaaaaaaaaaaa';
const cowork = path.join(appDir, 'local-agent-mode-sessions', account);
const sandbox = '/sessions/brave-otter';

write(path.join(cowork, 'local_cw1.json'), {
  sessionId: 'local_cw1', cliSessionId: COWORK_ID, sessionType: 'agent', title: 'Quarterly report draft',
  createdAt: now - 5_000, lastActivityAt: now - 4_000, isArchived: false, userSelectedFolders: ['/Users/pat/Reports']
});
write(path.join(cowork, 'local_cw1', '.claude', 'projects', '-sessions-brave-otter', `${COWORK_ID}.jsonl`), jsonl([
  turn('user', 'Turn the spreadsheet in my Reports folder into a quarterly summary.', -5_000, sandbox, desktopMark),
  turn('assistant', 'The summary covers revenue, churn and the capybara cohort.', -4_900, sandbox, desktopMark)
]), 30_000);
write(path.join(cowork, 'local_cw1', '.claude', 'projects', '-sessions-brave-otter', COWORK_ID, 'subagents', `agent-${COWORK_AGENT}.jsonl`), jsonl([
  turn('user', 'Check the churn numbers against the ledger.', -4_950, sandbox, { isSidechain: true, agentId: COWORK_AGENT }),
  turn('assistant', 'Churn matches the ledger except for one axolotl account.', -4_940, sandbox, { isSidechain: true, agentId: COWORK_AGENT })
]), 31_000);
write(path.join(cowork, 'local_cw1', '.claude', 'projects', '-sessions-brave-otter', COWORK_ID, 'subagents', `agent-${COWORK_AGENT}.meta.json`),
  { agentType: 'general-purpose', description: 'Ledger cross-check' });
write(path.join(cowork, 'local_cw1', '.claude', 'projects', '-sessions-brave-otter', `${COWORK_SIDE_ID}.jsonl`), jsonl([
  turn('user', 'A second transcript in the same storage folder mentions a quokka.', -4_800, sandbox, desktopMark),
  turn('assistant', 'Noted.', -4_700, sandbox, desktopMark)
]), 32_000);
write(path.join(cowork, 'local_cw1', 'outputs', 'summary.md'), '# Summary');
write(path.join(cowork, 'local_cw1', 'uploads', '.claude', 'projects', '-decoy', `${PLAIN_ID}.jsonl`), jsonl([turn('user', 'decoy upload narwhal', -1, '/x')]));

write(path.join(cowork, 'local_cw2.json'), { sessionId: 'local_cw2', cliSessionId: COWORK_CHAT_ID, sessionType: 'chat', title: 'Naming ideas' });
write(path.join(cowork, 'local_cw2', '.claude', 'projects', '-sessions-quiet-heron', `${COWORK_CHAT_ID}.jsonl`), jsonl([
  turn('user', 'Suggest names for a scheduling tool.', -3_000, '/sessions/quiet-heron'),
  turn('assistant', 'How about Tempo, Slate or Meridian?', -2_900, '/sessions/quiet-heron')
]), 40_000);

// A storage folder one level deeper than expected, and one with no record.
write(path.join(cowork, 'spaces', 'local_cw3', '.claude', 'projects', '-sessions-deep', `${COWORK_DEEP_ID}.jsonl`), jsonl([
  turn('user', 'A session nested deeper mentions a pangolin.', -2_000, '/sessions/deep'),
  turn('assistant', 'Noted.', -1_900, '/sessions/deep')
]), 50_000);

// Records that do not name their transcript: one storage folder with a
// single transcript, one with two. The first worked in the same folder as
// the report session above.
write(path.join(cowork, 'local_cw4.json'), { sessionId: 'local_cw4', sessionType: 'agent', title: 'Solo notes', userSelectedFolders: ['/Users/pat/Reports'] });
write(path.join(cowork, 'local_cw4', '.claude', 'projects', '-sessions-calm-ibis', `${COWORK_SOLO_ID}.jsonl`), jsonl([
  turn('user', 'Keep notes for the planning meeting.', -1_800, '/sessions/calm-ibis'),
  turn('assistant', 'Notes started.', -1_700, '/sessions/calm-ibis')
]), 52_000);
write(path.join(cowork, 'local_cw5.json'), { sessionId: 'local_cw5', sessionType: 'agent', title: 'Twin sessions' });
for (const [id, age] of [[COWORK_TWIN_A, 54_000], [COWORK_TWIN_B, 56_000]]) {
  write(path.join(cowork, 'local_cw5', '.claude', 'projects', '-sessions-twin', `${id}.jsonl`), jsonl([
    turn('user', 'One of two transcripts in a folder.', -1_600, '/sessions/twin'),
    turn('assistant', 'Noted.', -1_500, '/sessions/twin')
  ]), age);
}

// Things that live beside sessions and are not sessions.
write(path.join(appDir, 'local-agent-mode-sessions', 'skills-plugin', 'x', 'y', '.claude', 'projects', '-decoy', `${PLAIN_ID}.jsonl`), jsonl([turn('user', 'decoy skill narwhal', -1, '/x')]));
write(path.join(cowork, 'rpm', 'manifest.json'), {});
write(path.join(cowork, 'scheduled-tasks.json'), { scheduledTasks: [] });

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
const withoutApp = {
  ...cleanEnv,
  NO_COLOR: '1',
  TZ: 'UTC',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: path.join(root, 'codex'),
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
};
const env = { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: appDir };
const cli = (args, vars = env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: vars, timeout: 30_000 });
function ok(args, vars = env) {
  const result = cli(args, vars);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stderr, '', `unexpected stderr from ${args.join(' ')}`);
  return result.stdout;
}
const json = (args, vars = env) => JSON.parse(ok([...args, '--json'], vars));
const byId = (rows, id) => rows.find(row => row.sessionId === id);

console.log('\nwhere the app keeps things');

await test('the data directory follows the platform and can be named or turned off', () => {
  const at = (vars, platform) => desktopDataDir(vars, { home: '/home/pat', platform });
  assert.equal(at({}, 'darwin'), '/home/pat/Library/Application Support/Claude');
  assert.equal(at({}, 'linux'), '/home/pat/.config/Claude');
  assert.equal(at({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), '/cfg/Claude');
  assert.equal(at({ APPDATA: 'C:\\Users\\pat\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\pat\\AppData\\Roaming', 'Claude'));
  assert.equal(at({}, 'win32'), null);
  // On Windows the build from the Microsoft Store keeps its profile inside its package.
  const all = (vars, platform) => desktopDataDirs(vars, { home: '/home/pat', platform });
  assert.deepEqual(all({ APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, 'win32'),
    [path.join('C:\\A', 'Claude'), path.join('C:\\L', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude')]);
  assert.equal(all({ LOCALAPPDATA: 'C:\\L' }, 'win32').length, 1);
  assert.deepEqual(all({ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, 'darwin'), []);
  assert.deepEqual(all({}, 'linux'), ['/home/pat/.config/Claude']);
  assert.equal(at({ SESSIONS_CLAUDE_DESKTOP_DIR: '/elsewhere' }, 'darwin'), '/elsewhere');
  assert.equal(at({ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, 'darwin'), null);
  // Moving the Claude directory, as tests do, leaves the real app data alone.
  assert.equal(at({ SESSIONS_CLAUDE_DIR: '/tmp/x' }, 'darwin'), null);
  assert.equal(at({ SESSIONS_CLAUDE_DIR: '/tmp/x', SESSIONS_CLAUDE_DESKTOP_DIR: '/app' }, 'darwin'), '/app');
});

await test('a record keeps the title, the tab and the transcript it belongs to', () => {
  const code = desktopRecord({ sessionId: 'local_1', cliSessionId: 'abc', title: '  Named  ', isArchived: true, cwd: '/w', createdAt: 1_700_000_000_000 }, 'code');
  assert.deepEqual([code.desktopId, code.transcriptId, code.title, code.kind, code.archived, code.cwd, code.transcriptOnDisk],
    ['local_1', 'abc', 'Named', 'code', true, '/w', true]);
  assert.equal(code.createdAt.toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(desktopRecord({ sessionType: 'agent' }, 'cowork').kind, 'cowork');
  assert.equal(desktopRecord({ sessionType: 'dispatch_child' }, 'cowork').kind, 'cowork');
  assert.equal(desktopRecord({ sessionType: 'chat' }, 'cowork').kind, 'chat');
  assert.equal(desktopRecord({ sessionType: 'scheduled' }, 'cowork').kind, 'scheduled');
  assert.deepEqual(desktopRecord({ userSelectedFolders: ['/a', 7, ''] }, 'cowork').folders, ['/a']);
  assert.equal(desktopRecord({ transcriptUnavailable: true }, 'code').transcriptOnDisk, false);
  assert.equal(desktopRecord(null, 'code'), null);
  assert.equal(desktopRecord([], 'code'), null);
  assert.equal(desktopNote({ app: 'desktop', desktopKind: 'code' }), '(desktop)');
  assert.equal(desktopNote({ app: 'desktop', desktopKind: 'cowork' }), '(desktop cowork)');
  assert.equal(desktopNote({}), '');
});

await test('records and Cowork folders are found by what they are', async () => {
  const records = await readCodeRecords(appDir);
  assert.deepEqual([...records.keys()].sort(), [CODE_ID, ARCHIVED_ID, GONE_ID, CLASH_ID].sort());
  assert.equal(records.get(CODE_ID).title, 'Computer abilities overview');
  const folders = await findCoworkSessions(appDir);
  assert.deepEqual(folders.map(found => path.basename(found.storageDir)), ['local_cw1', 'local_cw2', 'local_cw4', 'local_cw5', 'local_cw3']);
  assert.deepEqual(folders.map(found => found.record.title), ['Quarterly report draft', 'Naming ideas', 'Solo notes', 'Twin sessions', null]);
  assert.deepEqual(folders.map(found => found.record.kind), ['cowork', 'chat', 'cowork', 'cowork', 'cowork']);
  assert.deepEqual(folders.map(found => found.record.transcriptId), [COWORK_ID, COWORK_CHAT_ID, null, null, null]);
  assert.deepEqual(await findCoworkSessions(path.join(root, 'no-such-app')), []);
  assert.equal((await readCodeRecords(path.join(root, 'no-such-app'))).size, 0);
});

console.log('\nCode tab sessions');

await test('are listed with the name the app shows and marked as the app\'s', () => {
  const sessions = json(['list']);
  const code = byId(sessions, CODE_ID);
  assert.deepEqual([code.app, code.desktopKind, code.title, code.named, code.project], ['desktop', 'code', 'Computer abilities overview', true, '/work/app']);
  assert.equal(byId(sessions, ARCHIVED_ID).archived, true);
  assert.equal(byId(sessions, ARCHIVED_ID).title, 'Release checklist');
  for (const id of [RENAMED_ID, PLAIN_ID]) assert.equal('app' in byId(sessions, id), false, id);
  // The app remembers a session whose transcript is gone; there is nothing to read.
  assert.equal(byId(sessions, GONE_ID), undefined);
  const out = ok(['list']);
  assert.match(out, /^aaaaaaaa \[claude\] \/work\/app \(desktop\) .*\n {2}Computer abilities overview {2}what can you do on this computer$/m);
  assert.match(out, /^cccccccc \[claude\] \/work\/app (?!\(desktop\)).*\n {2}list the open pull requests$/m);
});

await test('show says which app and tab a session ran in', () => {
  const out = ok(['show', 'aaaaaaaa']);
  assert.match(out, /^Title: Computer abilities overview\nApp: Claude desktop \(Code tab\)$/m);
  assert.match(out, /I can read files, run commands/);
  assert.doesNotMatch(ok(['show', 'cccccccc']), /^(Title|App): /m);
  // The record of its name is not a message.
  assert.deepEqual(json(['show', 'aaaaaaaa']).map(message => message.type), ['user', 'assistant']);
  assert.doesNotMatch(ok(['export', 'aaaaaaaa', '-f', 'text']), /custom-title|Computer abilities overview/);
});

await test('a name written into a transcript is read, in the terminal too', () => {
  // With and without --full: the name does not take reading the whole transcript.
  for (const args of [['list'], ['list', '--full']]) {
    const renamed = byId(json(args), RENAMED_ID);
    assert.deepEqual([renamed.title, renamed.named], ['Exporter cleanup', true], args.join(' '));
    assert.match(ok(args), /^ {2}Exporter cleanup {2}refactor the invoice exporter$/m, args.join(' '));
  }
  assert.equal(byId(json(['list', '--full']), RENAMED_ID).messageCount, 2);
  assert.match(ok(['show', 'bbbbbbbb']), /^Title: Exporter cleanup$/m);
  assert.equal('named' in byId(json(['list']), PLAIN_ID), false);
});

await test('the name is read where Claude Code keeps it, without reading the transcript', () => {
  const sessions = json(['list']);
  // A long transcript: the latest name sits in its last 64 KB.
  assert.deepEqual([byId(sessions, NEAR_ID).title, byId(sessions, NEAR_ID).named], ['Late rename', true]);
  // Named at the start and never again: the first 64 KB are looked at last.
  assert.deepEqual([byId(sessions, BURIED_ID).title, byId(sessions, BURIED_ID).named], ['Buried name', true]);
  // In between, Claude Code's own session list does not look, and neither does this.
  assert.equal('title' in byId(sessions, MIDDLE_ID), false);
  // The file kept beside a transcript.
  assert.deepEqual([byId(sessions, SIDECAR_ID).title, byId(sessions, SIDECAR_ID).named], ['Sidecar kept name', true]);
  assert.match(ok(['show', SIDECAR_ID]), /^Title: Sidecar kept name$/m);
  assert.deepEqual(json(['search', 'sidecar kept']).map(row => [row.sessionId, row.type]), [[SIDECAR_ID, 'title']]);
});

await test('the name the app shows wins wherever a name is used', () => {
  // Renamed in the app; the transcript still carries the name it had before.
  for (const args of [['list'], ['list', '--full']]) assert.equal(byId(json(args), CLASH_ID).title, 'Billing rework', args.join(' '));
  assert.match(ok(['show', CLASH_ID]), /^Title: Billing rework\nApp: Claude desktop \(Code tab\)$/m);
  assert.deepEqual(json(['search', '"billing rework"']).map(row => [row.sessionId, row.type]), [[CLASH_ID, 'title']]);
  assert.equal(json(['search', '"invoice cleanup"']).length, 0);
  // Without the app's data, the transcript's own name stands.
  assert.equal(byId(json(['list'], withoutApp), CLASH_ID).title, 'Invoice cleanup');
});

await test('without the app\'s data they are ordinary sessions', () => {
  const sessions = json(['list'], withoutApp);
  assert.deepEqual(sessions.map(session => session.sessionId).sort(), [...OWN_IDS].sort());
  assert.equal(sessions.some(session => 'app' in session), false);
  assert.equal(json(['list'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: path.join(root, 'no-such-app') }).length, OWN_IDS.length);
});

console.log('\nCowork sessions');

await test('are found in their own folders and listed with the rest', () => {
  const sessions = json(['list']);
  assert.equal(sessions.length, OWN_IDS.length + 7);
  const cw = byId(sessions, COWORK_ID);
  // The folder the person gave it, not the sandbox path it ran in.
  assert.deepEqual([cw.app, cw.desktopKind, cw.title, cw.project], ['desktop', 'cowork', 'Quarterly report draft', '/Users/pat/Reports']);
  assert.equal(cw.filePath.includes(path.join('local_cw1', '.claude', 'projects')), true);
  const chat = byId(sessions, COWORK_CHAT_ID);
  assert.deepEqual([chat.desktopKind, chat.title, chat.project], ['chat', 'Naming ideas', '/sessions/quiet-heron']);
  const deep = byId(sessions, COWORK_DEEP_ID);
  assert.deepEqual([deep.app, deep.desktopKind, deep.project, 'title' in deep], ['desktop', 'cowork', '/sessions/deep', false]);
  assert.match(ok(['list']), /^99999999 \[claude\] \/Users\/pat\/Reports \(desktop cowork\) .*\n {2}Quarterly report draft {2}Turn the spreadsheet/m);
  assert.match(ok(['list', '-p', 'Reports']), /^3 sessions /);
  assert.equal(json(['projects']).some(project => project.path === '/Users/pat/Reports'), true);
});

await test('a record names its own transcript, not every one in its folder', () => {
  const sessions = json(['list']);
  const side = byId(sessions, COWORK_SIDE_ID);
  assert.deepEqual([side.app, side.desktopKind, 'title' in side, side.project], ['desktop', 'cowork', false, '/Users/pat/Reports']);
  assert.deepEqual(json(['search', 'report quarterly draft']).map(row => row.sessionId), [COWORK_ID]);
  assert.equal(json(['search', 'quokka'])[0].sessionId, COWORK_SIDE_ID);
  // A record that does not say which transcript is its own speaks for a
  // folder that holds one, and for neither when it holds two.
  assert.deepEqual([byId(sessions, COWORK_SOLO_ID).title, byId(sessions, COWORK_SOLO_ID).named], ['Solo notes', true]);
  for (const id of [COWORK_TWIN_A, COWORK_TWIN_B]) {
    assert.deepEqual([byId(sessions, id).app, 'title' in byId(sessions, id)], ['desktop', false], id);
  }
});

await test('projects counts a folder once however many sessions worked in it', () => {
  for (const args of [['projects'], ['projects', '--source', 'claude']]) {
    const reports = json(args).filter(project => project.path === '/Users/pat/Reports');
    assert.equal(reports.length, 1, args.join(' '));
    assert.equal(reports[0].sessionCount, 3, args.join(' '));
  }
  // Nothing of how the tool finds its way around leaks into what it reports.
  const [first] = json(['projects', '--source', 'claude']);
  assert.deepEqual(Object.keys(first).sort(), ['encoded', 'path', 'sessionCount', 'source', 'totalSize']);
  assert.equal(ok(['projects', '--source', 'claude']).split('\n').filter(line => line.startsWith('/Users/pat/Reports ')).length, 1);
});

await test('uploads, plugins and caches beside them are not sessions', () => {
  assert.equal(json(['search', 'narwhal']).length, 0);
  assert.equal(json(['list', '--subagents']).some(session => /decoy/.test(session.filePath)), false);
});

await test('can be shown, exported and searched like any session', () => {
  const shown = ok(['show', COWORK_ID]);
  assert.match(shown, /^Title: Quarterly report draft\nApp: Claude desktop \(Cowork\)$/m);
  assert.match(shown, /capybara cohort/);
  assert.match(ok(['show', COWORK_CHAT_ID]), /^App: Claude desktop \(Cowork chat\)$/m);
  assert.match(ok(['export', COWORK_ID, '-f', 'text']), /Turn the spreadsheet in my Reports folder/);
  const [row] = json(['search', 'capybara']);
  assert.deepEqual([row.sessionId, row.app, row.desktopKind, row.title, row.seq], [COWORK_ID, 'desktop', 'cowork', 'Quarterly report draft', 1]);
  assert.match(ok(['search', 'capybara']), /^99999999 \[claude\] \/Users\/pat\/Reports \(desktop cowork\) claude .* #1$/m);
  assert.equal(json(['search', 'pangolin'])[0].sessionId, COWORK_DEEP_ID);
  assert.match(ok(['recap', '--days', '1']), /Turn the spreadsheet in my Reports folder/);
});

await test('their subagents are searched too', () => {
  const [row] = json(['search', 'axolotl']);
  assert.deepEqual([row.sessionId, row.subagent, row.parentSessionId], [COWORK_AGENT, true, COWORK_ID]);
  assert.match(ok(['show', COWORK_AGENT]), /^Subagent of: 99999999-1111-4222-8333-aaaaaaaaaaaa \(general-purpose: Ledger cross-check\)$/m);
});

await test('what a subagent was asked to do is shown and is not a name', () => {
  const agents = json(['list', '--subagents']).filter(session => session.subagent);
  assert.deepEqual(agents.map(agent => [agent.sessionId, agent.title, 'named' in agent]), [[COWORK_AGENT, 'Ledger cross-check', false]]);
  assert.match(ok(['list', '--subagents']), /^a7777777 \[claude\] .*\(subagent of 99999999\) .*\n {2}Ledger cross-check {2}Check the churn numbers/m);
  assert.equal(json(['search', '"Ledger cross-check"']).length, 0);
});

await test('sync would index them', () => {
  const out = ok(['sync', '--dry-run']);
  assert.match(out, /^Would index 17 sessions, /);
  assert.match(out, /1 subagent transcript among them/);
});

console.log('\nfinding a session by its name');

await test('a name nobody said in the session still finds it', () => {
  const rows = json(['search', 'abilities overview']);
  assert.deepEqual(rows.map(row => [row.sessionId, row.type, row.seq, row.title]), [[CODE_ID, 'title', 0, 'Computer abilities overview']]);
  const out = ok(['search', 'abilities overview']);
  assert.match(out, /^1 match in 1 session\naaaaaaaa \[claude\] \/work\/app \(desktop\) title .* #0\n {4}Computer abilities overview$/m);
  // There is no matching message to drill into, so the closing line says how to read it.
  assert.match(out, /^Read it: sessions show aaaaaaaa$/m);
  assert.doesNotMatch(out, /--session aaaaaaaa/);
  // The same for a Cowork session, a name given with /rename, and words in any order.
  assert.deepEqual(json(['search', 'report quarterly draft']).map(row => [row.sessionId, row.type]), [[COWORK_ID, 'title']]);
  assert.deepEqual(json(['search', 'Exporter cleanup']).map(row => [row.sessionId, row.type]), [[RENAMED_ID, 'title']]);
  // Only the latest name counts.
  assert.equal(json(['search', '"First name"']).length, 0);
});

await test('a message that matches speaks for its session, not the name', () => {
  const rows = json(['search', 'checklist', '--per-session', '5']);
  assert.deepEqual(rows.map(row => [row.sessionId, row.type]), [[ARCHIVED_ID, 'user'], [ARCHIVED_ID, 'assistant']]);
  assert.equal(rows[0].title, 'Release checklist');
});

await test('names stay out of searches that are about something else', () => {
  assert.equal(json(['search', 'abilities overview', '--literal']).length, 0);
  assert.equal(json(['search', 'abilities overview', '--role', 'user']).length, 0);
  assert.equal(json(['search', 'abilities overview', '--tool', 'Bash']).length, 0);
  assert.equal(ok(['search', 'abilities overview', '--session', 'aaaaaaaa']), 'No matches for "abilities overview" in aaaaaaaa.\n');
  assert.equal(json(['search', 'abilities NOT overview']).length, 0);
  assert.equal(json(['search', 'abilities overview'], withoutApp)[0].type, 'title', 'the transcript carries the name as well');
});

console.log('\nwhen something is off');

await test('a title that is not text is not a title', () => {
  const kimi = path.join(root, 'kimi-odd');
  const dir = path.join(kimi, 'sessions', 'wd_odd', 'session_k1');
  write(path.join(dir, 'state.json'), { workDir: '/work/kimi', title: 42 });
  write(path.join(dir, 'agents', 'main', 'wire.jsonl'), '');
  const vars = { ...env, SESSIONS_KIMI_DIR: kimi };
  const [session] = json(['list', '--source', 'kimi'], vars);
  assert.deepEqual([session.sessionId, session.title, 'named' in session], ['k1', null, false]);
  assert.match(ok(['list', '--source', 'kimi'], vars), /^k1 \[kimi\] \/work\/kimi /m);
});

// Taking away read permission means nothing to root or on Windows.
const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;
const lockedNote = canLock ? '' : ' (not checked: permissions cannot be taken away here)';

await test(`an app folder that cannot be read is named, left out, and never pruned${lockedNote}`, () => {
  if (!canLock) return;
  const lockedApp = path.join(root, 'app-locked');
  const org = path.join(lockedApp, 'local-agent-mode-sessions', 'acct', 'org');
  const transcript = (folder, name) => write(path.join(folder, name), jsonl([turn('user', 'locked away wombat', -1_000, '/sessions/locked')]));
  // Three ways a session's folder can be out of reach: a project folder that
  // cannot be listed, a session folder that cannot be entered (as deep as
  // the app nests them), and a projects folder that lists and does not open.
  const slug = path.join(org, 'local_x', '.claude', 'projects', '-sessions-locked');
  transcript(slug, 'abababab-1111-4222-8333-abababababab.jsonl');
  const closed = path.join(org, 'agent', 'local_y', '.claude');
  transcript(path.join(closed, 'projects', '-sessions-closed'), 'abababab-2222-4222-8333-abababababab.jsonl');
  const listable = path.join(org, 'local_z', '.claude', 'projects');
  transcript(path.join(listable, '-sessions-listable'), 'abababab-3333-4222-8333-abababababab.jsonl');
  const locks = [[slug, 0o000], [closed, 0o000], [listable, 0o444]];
  for (const [folder, mode] of locks) chmodSync(folder, mode);
  try {
    const vars = { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: lockedApp };
    const listed = cli(['list', '--json'], vars);
    assert.equal(listed.status, 0, listed.stderr);
    const named = listed.stderr.trimEnd().split('\n');
    assert.equal(named.length, 3, listed.stderr);
    for (const line of named) assert.match(line, /^Could not read .+ \(EACCES\); sessions there are left out\.$/);
    for (const part of ['-sessions-locked', 'local_y', '-sessions-listable']) assert.equal(named.some(line => line.includes(part)), true, part);
    assert.equal(JSON.parse(listed.stdout).length, OWN_IDS.length);
    assert.equal(cli(['search', 'pull requests', '--json'], vars).status, 0);
    // A session that could not be seen is not a session that was deleted.
    const pruning = cli(['sync', '--prune', '--dry-run'], vars);
    assert.equal(pruning.status, 1);
    assert.match(pruning.stderr, /Not pruning: 3 folders could not be read .*, so sessions in them would look deleted/);
    assert.equal(cli(['sync', '--dry-run'], vars).status, 0);
  } finally {
    for (const [folder] of locks) chmodSync(folder, 0o755);
  }
});

await test(`Claude Code's own folder failing to read stops the command, as it always has${lockedNote}`, () => {
  if (!canLock) return;
  const lockedClaude = path.join(root, 'claude-locked');
  const projects = path.join(lockedClaude, 'projects');
  mkdirSync(projects, { recursive: true });
  chmodSync(projects, 0o000);
  try {
    const result = cli(['list'], { ...withoutApp, SESSIONS_CLAUDE_DIR: lockedClaude });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EACCES/);
    assert.doesNotMatch(result.stdout, /No sessions found/);
  } finally {
    chmodSync(projects, 0o755);
  }
});

rmSync(root, { recursive: true, force: true });
console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
