#!/usr/bin/env node

// Tests for sessions of the Claude desktop app: Code tab sessions, which keep
// their transcript where the CLI does and their title in the app's data, and
// Cowork sessions, which keep their transcript in a folder of their own.
// Hermetic: the app's data directory is a temporary one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.js';
import { desktopDataDir, desktopDataDirs, desktopNote, desktopRecord, findCoworkSessions, namedDesktopDirs, namedFolderTrouble, readCodeRecords } from '../lib/desktop.js';

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

// --- a second data folder, the way newer versions of the app lay one out ---
//
// The record keeps the session's full name; the storage folder is named with
// the first eight characters of the uuid.

const appShort = path.join(root, 'app-short');
const coworkShort = path.join(appShort, 'local-agent-mode-sessions', account);
const SHORT_ID = '5a5a5a5a-0000-4222-8333-000000000001';        // a short folder beside its full-named record
const PAIR_FULL_ID = '6b6b6b6b-0000-4222-8333-000000000002';    // two sessions that begin with the same eight characters:
const PAIR_SHORT_ID = '6b6b6b6b-0000-4222-8333-000000000003';   // one in a full-named folder, one in the short one
const MOVED_OLD_ID = '7c7c7c7c-0000-4222-8333-000000000004';    // a folder named like nothing, found by the transcripts
const MOVED_ID = '7c7c7c7c-0000-4222-8333-000000000005';        // its record lists: the one before, and the current one
const STRAY_ID = '9e9e9e9e-0000-4222-8333-000000000006';        // a short folder whose record is gone
const AGENT_ID = 'aeaeaeae-0000-4222-8333-000000000007';        // under agent/, where the app keeps some kinds
const EARLIER_ID = '5a5a5a5a-0000-4222-8333-000000000014';      // the transcript that session had before, kept in a folder of its own
const SHORT_IDS = [SHORT_ID, PAIR_FULL_ID, PAIR_SHORT_ID, MOVED_OLD_ID, MOVED_ID, STRAY_ID, AGENT_ID, 'abababab-0000-4222-8333-00000000000a', EARLIER_ID];
const record = (uuid, fields) => ({ sessionId: `local_${uuid}`, sessionType: 'agent', createdAt: now - 9_000, lastActivityAt: now - 8_000, ...fields });
const said = (folder, id, words, age) => write(path.join(folder, '.claude', 'projects', '-private-var-empty', `${id}.jsonl`), jsonl([
  turn('user', words, -3_000, '/private/var/empty', desktopMark),
  turn('assistant', 'Noted.', -2_900, '/private/var/empty', desktopMark)
]), age);

const shortUuid = '5a5a5a5a-aaaa-4bbb-8ccc-111111111111';
write(path.join(coworkShort, `local_${shortUuid}.json`), record(shortUuid, { cliSessionId: SHORT_ID, previousCliSessionIds: [EARLIER_ID], title: 'Budget review notes', userSelectedFolders: ['/Users/pat/Budget'] }));
said(path.join(coworkShort, 'kept-from-before'), EARLIER_ID, 'Open the budget and find the bongo line.', 20_500);
said(path.join(coworkShort, '5a5a5a5a'), SHORT_ID, 'Go through the budget and flag the okapi line.', 20_000);

const pairFull = '6b6b6b6b-aaaa-4bbb-8ccc-222222222222';
const pairShort = '6b6b6b6b-dddd-4bbb-8ccc-333333333333';
write(path.join(coworkShort, `local_${pairFull}.json`), record(pairFull, { cliSessionId: PAIR_FULL_ID, title: 'Vendor shortlist' }));
said(path.join(coworkShort, `local_${pairFull}`), PAIR_FULL_ID, 'Shortlist three vendors for the tapir contract.', 21_000);
write(path.join(coworkShort, `local_${pairShort}.json`), record(pairShort, { cliSessionId: PAIR_SHORT_ID, title: 'Offsite agenda' }));
said(path.join(coworkShort, '6b6b6b6b'), PAIR_SHORT_ID, 'Draft the agenda for the offsite, lemur session first.', 22_000);

const movedUuid = '7c7c7c7c-aaaa-4bbb-8ccc-444444444444';
write(path.join(coworkShort, `local_${movedUuid}.json`), record(movedUuid, { cliSessionId: MOVED_ID, previousCliSessionIds: [MOVED_OLD_ID, MOVED_ID], title: 'Hiring plan' }));
said(path.join(coworkShort, 'storage-17'), MOVED_OLD_ID, 'Start a hiring plan for the ocelot team.', 24_000);
// A file named like the folder that says nothing of a session does not
// stand in the way of the record that lists the folder's transcripts.
write(path.join(coworkShort, 'storage-17.json'), { note: 'kept by something else' });
said(path.join(coworkShort, 'storage-17'), MOVED_ID, 'Continue the hiring plan with the ocelot budget.', 23_000);

said(path.join(coworkShort, '9e9e9e9e'), STRAY_ID, 'A session whose record is gone mentions a numbat.', 25_000);

const agentUuid = 'aeaeaeae-aaaa-4bbb-8ccc-555555555555';
write(path.join(coworkShort, 'agent', `local_${agentUuid}.json`), record(agentUuid, { cliSessionId: AGENT_ID, title: 'Inbox triage', isArchived: true }));
said(path.join(coworkShort, 'agent', 'aeaeaeae'), AGENT_ID, 'Sort the inbox and list what needs a reply, the kakapo thread first.', 26_000);

// A short folder whose own record is gone, beside the record of another
// session that begins with the same eight characters and lists a transcript
// this folder does not hold.
const ORPHAN_ID = 'abababab-0000-4222-8333-00000000000a';
const lookalikeUuid = 'abababab-aaaa-4bbb-8ccc-777777777770';
said(path.join(coworkShort, 'abababab'), ORPHAN_ID, 'A session whose record is gone mentions a tarsier.', 25_500);
write(path.join(coworkShort, `local_${lookalikeUuid}.json`), record(lookalikeUuid, { cliSessionId: GONE_ID, title: 'Someone else, same start', isArchived: true, userSelectedFolders: ['/Users/pat/Elsewhere'] }));

// Beside them: a session the app remembers and has no folder for, and files
// that are not records of sessions.
const goneUuid = '8d8d8d8d-aaaa-4bbb-8ccc-666666666666';
write(path.join(coworkShort, `local_${goneUuid}.json`), record(goneUuid, { cliSessionId: GONE_ID, title: 'No longer on disk' }));
write(path.join(coworkShort, 'cowork_settings.json'), { cliSessionId: STRAY_ID, title: 'Not a session' });
write(path.join(coworkShort, 'spaces.json'), { spaces: [] });

// --- a third data folder: records that are not plain files beside a folder ---

const appOdd = path.join(root, 'app-odd');
const coworkOdd = path.join(appOdd, 'local-agent-mode-sessions', account);
const LINKED_ID = 'b1b1b1b1-0000-4222-8333-000000000008';      // its record is a link to a file kept elsewhere
const NAMESAKE_ID = 'c1c1c1c1-0000-4222-8333-000000000009';    // a file named like its folder that is not its record
const linkedUuid = 'b1b1b1b1-aaaa-4bbb-8ccc-777777777777';
const namesakeUuid = 'c1c1c1c1-aaaa-4bbb-8ccc-888888888888';
said(path.join(coworkOdd, 'b1b1b1b1'), LINKED_ID, 'Plan the move, the tamarin boxes first.', 27_000);
write(path.join(root, 'records-elsewhere', 'linked.json'), record(linkedUuid, { cliSessionId: LINKED_ID, title: 'Office move plan' }));
// Links need a privilege on Windows that a test run may not have.
let canLink = true;
try {
  symlinkSync(path.join(root, 'records-elsewhere', 'linked.json'), path.join(coworkOdd, `local_${linkedUuid}.json`));
} catch {
  canLink = false;
}
said(path.join(coworkOdd, 'c1c1c1c1'), NAMESAKE_ID, 'Compare the two leases, the marmoset clause too.', 28_000);
write(path.join(coworkOdd, 'c1c1c1c1.json'), { note: 'a file that happens to be named like the folder' });
write(path.join(coworkOdd, `local_${namesakeUuid}.json`), record(namesakeUuid, { cliSessionId: NAMESAKE_ID, title: 'Lease comparison' }));

// --- two data folders that each hold a folder of the same name at the same
// place, for two different sessions ---

const TWIN_ONE_ID = 'd1d1d1d1-0000-4222-8333-00000000000a';
const TWIN_TWO_ID = 'd1d1d1d1-0000-4222-8333-00000000000b';
const twinDirs = ['app-twin-one', 'app-twin-two'].map(name => path.join(root, name));
for (const [dir, id, uuid, title] of [
  [twinDirs[0], TWIN_ONE_ID, 'd1d1d1d1-aaaa-4bbb-8ccc-999999999991', 'Travel booking'],
  [twinDirs[1], TWIN_TWO_ID, 'd1d1d1d1-bbbb-4bbb-8ccc-999999999992', 'Expense report']
]) {
  const at = path.join(dir, 'local-agent-mode-sessions', account);
  write(path.join(at, `local_${uuid}.json`), record(uuid, { cliSessionId: id, title }));
  said(path.join(at, 'd1d1d1d1'), id, `Start on the ${title.toLowerCase()}.`, 29_000);
}

// --- one session the app has kept in two of its data folders: an older copy
// under the full folder name, which also still holds the transcript the
// session had before, and a newer copy under the short name ---

const KEPT_BEFORE_ID = 'e1e1e1e1-0000-4222-8333-00000000000c';   // only in the older copy
const KEPT_ID = 'e1e1e1e1-0000-4222-8333-00000000000d';          // in both
const keptUuid = 'e1e1e1e1-aaaa-4bbb-8ccc-aaaaaaaaaaa1';
const copyDirs = ['app-copy-old', 'app-copy-new'].map(name => path.join(root, name));
{
  const older = path.join(copyDirs[0], 'local-agent-mode-sessions', account);
  write(path.join(older, `local_${keptUuid}.json`), record(keptUuid, { cliSessionId: KEPT_ID, previousCliSessionIds: [KEPT_BEFORE_ID], title: 'Supplier audit', lastActivityAt: now - 90_000 }));
  said(path.join(older, `local_${keptUuid}`), KEPT_BEFORE_ID, 'Begin the supplier audit with the pika invoices.', 95_000);
  said(path.join(older, `local_${keptUuid}`), KEPT_ID, 'Carry on with the supplier audit.', 90_000);
  const newer = path.join(copyDirs[1], 'local-agent-mode-sessions', account);
  write(path.join(newer, `local_${keptUuid}.json`), record(keptUuid, { cliSessionId: KEPT_ID, previousCliSessionIds: [KEPT_BEFORE_ID], title: 'Supplier audit, signed off', lastActivityAt: now - 30_000 }));
  write(path.join(newer, 'e1e1e1e1', '.claude', 'projects', '-private-var-empty', `${KEPT_ID}.jsonl`), jsonl([
    turn('user', 'Carry on with the supplier audit.', -3_000, '/private/var/empty', desktopMark),
    turn('assistant', 'Noted.', -2_900, '/private/var/empty', desktopMark),
    turn('user', 'Sign off the audit, the quoll report included.', -2_000, '/private/var/empty', desktopMark),
    turn('assistant', 'Signed off.', -1_900, '/private/var/empty', desktopMark)
  ]), 30_000);
}

// A record that says which session it is only by its file name.
const UNSIGNED_ID = 'd4d4d4d4-0000-4222-8333-000000000012';
const unsignedUuid = 'd4d4d4d4-aaaa-4bbb-8ccc-999999999994';
said(path.join(coworkOdd, `local_${unsignedUuid}`), UNSIGNED_ID, 'Book the venue, the quetzal room if free.', 28_800);
write(path.join(coworkOdd, `local_${unsignedUuid}.json`), { title: 'Venue booking', userSelectedFolders: ['/Users/pat/Events'] });

// A subagent of a session that was given no folder.
const ODD_AGENT = 'a9999999999999999';
write(path.join(coworkOdd, 'c1c1c1c1', '.claude', 'projects', '-private-var-empty', NAMESAKE_ID, 'subagents', `agent-${ODD_AGENT}.jsonl`), jsonl([
  turn('user', 'Check the break clause in both leases.', -2_500, '/private/var/empty', { isSidechain: true, agentId: ODD_AGENT }),
  turn('assistant', 'Both allow a break after year three.', -2_400, '/private/var/empty', { isSidechain: true, agentId: ODD_AGENT })
]), 28_500);

// --- copies that do not tell themselves apart by when they were written,
// and a copy whose folder has lost its record ---

const TIED_ID = 'f1f1f1f1-0000-4222-8333-00000000000e';     // the same file in both, one record active later
const STRAY_COPY_ID = 'f2f2f2f2-0000-4222-8333-00000000000f'; // the newer copy sits in a folder with no record
const TIE_AGENT = 'a8888888888888888';
const TIE_AGENT_TWO = 'a8888888888888889';
const UNFILED_ID = 'f3f3f3f3-0000-4222-8333-000000000010';
const SOLE_COPY_ID = 'f4f4f4f4-0000-4222-8333-000000000011';   // its record lists no transcript; the newer copy has no record
const REFILED_ID = 'f5f5f5f5-0000-4222-8333-000000000013';     // given another folder since; a subagent sits beside the older copy
const REFILED_AGENT = 'a8888888888888890';     // given a folder once, none by the record active last
const tieDirs = ['app-tie-one', 'app-tie-two'].map(name => path.join(root, name));
{
  const [one, two] = tieDirs.map(dir => path.join(dir, 'local-agent-mode-sessions', account));
  const tiedUuid = 'f1f1f1f1-aaaa-4bbb-8ccc-bbbbbbbbbbb1';
  const same = [turn('user', 'Reconcile the ledger with the bank export.', -4_000, '/private/var/empty', desktopMark), turn('assistant', 'Reconciled, one ibex entry is open.', -3_900, '/private/var/empty', desktopMark)];
  for (const at of [one, two]) write(path.join(at, `local_${tiedUuid}`, '.claude', 'projects', '-private-var-empty', `${TIED_ID}.jsonl`), jsonl(same), 70_000);
  write(path.join(one, `local_${tiedUuid}.json`), record(tiedUuid, { cliSessionId: TIED_ID, title: 'Ledger', lastActivityAt: now - 80_000 }));
  write(path.join(two, `local_${tiedUuid}.json`), record(tiedUuid, { cliSessionId: TIED_ID, title: 'Ledger reconciled', isArchived: true, userSelectedFolders: ['/Users/pat/Ledger'], lastActivityAt: now - 60_000 }));

  const strayUuid = 'f2f2f2f2-aaaa-4bbb-8ccc-bbbbbbbbbbb2';
  write(path.join(one, `local_${strayUuid}.json`), record(strayUuid, { cliSessionId: STRAY_COPY_ID, title: 'Launch plan', userSelectedFolders: ['/Users/pat/Plans'] }));
  const older = path.join(one, `local_${strayUuid}`, '.claude', 'projects', '-private-var-empty');
  write(path.join(older, `${STRAY_COPY_ID}.jsonl`), jsonl([turn('user', 'Draft the launch plan.', -5_000, '/private/var/empty', desktopMark)]), 75_000);
  // What a subagent left sits only beside the older copy.
  write(path.join(older, STRAY_COPY_ID, 'subagents', `agent-${TIE_AGENT}.jsonl`), jsonl([
    turn('user', 'List the launch risks.', -4_900, '/private/var/empty', { isSidechain: true, agentId: TIE_AGENT }),
    turn('assistant', 'Three risks, the wombat dependency first.', -4_800, '/private/var/empty', { isSidechain: true, agentId: TIE_AGENT })
  ]), 74_000);
  write(path.join(two, 'recovered-folder', '.claude', 'projects', '-private-var-empty', `${STRAY_COPY_ID}.jsonl`), jsonl([
    turn('user', 'Draft the launch plan.', -5_000, '/private/var/empty', desktopMark),
    turn('assistant', 'Drafted, with the dugong milestone last.', -4_950, '/private/var/empty', desktopMark)
  ]), 65_000);
  // And one beside the newer copy.
  write(path.join(two, 'recovered-folder', '.claude', 'projects', '-private-var-empty', STRAY_COPY_ID, 'subagents', `agent-${TIE_AGENT_TWO}.jsonl`), jsonl([
    turn('user', 'Price the launch venue.', -4_940, '/private/var/empty', { isSidechain: true, agentId: TIE_AGENT_TWO }),
    turn('assistant', 'The numbat hall is cheapest.', -4_930, '/private/var/empty', { isSidechain: true, agentId: TIE_AGENT_TWO })
  ]), 64_000);

  // A folder that held one transcript, with a record that lists none: the
  // record names it. The newer copy sits in a folder without a record.
  const soleUuid = 'f4f4f4f4-aaaa-4bbb-8ccc-bbbbbbbbbbb4';
  write(path.join(one, `local_${soleUuid}.json`), record(soleUuid, { title: 'Invoice run', isArchived: true, userSelectedFolders: ['/Users/pat/Invoices'] }));
  write(path.join(one, `local_${soleUuid}`, '.claude', 'projects', '-private-var-empty', `${SOLE_COPY_ID}.jsonl`), jsonl([turn('user', 'Run the invoices.', -4_300, '/private/var/empty', desktopMark)]), 73_000);
  write(path.join(two, 'recovered-too', '.claude', 'projects', '-private-var-empty', `${SOLE_COPY_ID}.jsonl`), jsonl([
    turn('user', 'Run the invoices.', -4_300, '/private/var/empty', desktopMark),
    turn('assistant', 'Run done, the echidna invoice is held.', -4_200, '/private/var/empty', desktopMark)
  ]), 63_000);

  // A session that was given another folder since. Each copy has its own
  // record, and what a subagent left is beside the older copy only.
  const refiledUuid = 'f5f5f5f5-aaaa-4bbb-8ccc-bbbbbbbbbbb5';
  write(path.join(one, `local_${refiledUuid}.json`), record(refiledUuid, { cliSessionId: REFILED_ID, title: 'Desk move', userSelectedFolders: ['/Users/pat/OldDesk'], lastActivityAt: now - 88_000 }));
  const before = path.join(one, `local_${refiledUuid}`, '.claude', 'projects', '-private-var-empty');
  write(path.join(before, `${REFILED_ID}.jsonl`), jsonl([turn('user', 'Plan the desk move.', -4_100, '/private/var/empty', desktopMark)]), 78_000);
  write(path.join(before, REFILED_ID, 'subagents', `agent-${REFILED_AGENT}.jsonl`), jsonl([
    turn('user', 'Measure the new desk.', -4_050, '/private/var/empty', { isSidechain: true, agentId: REFILED_AGENT }),
    turn('assistant', 'It is a tapir wide.', -4_000, '/private/var/empty', { isSidechain: true, agentId: REFILED_AGENT })
  ]), 77_000);
  write(path.join(two, `local_${refiledUuid}.json`), record(refiledUuid, { cliSessionId: REFILED_ID, title: 'Desk move', userSelectedFolders: ['/Users/pat/NewDesk'], lastActivityAt: now - 58_000 }));
  write(path.join(two, `local_${refiledUuid}`, '.claude', 'projects', '-private-var-empty', `${REFILED_ID}.jsonl`), jsonl([
    turn('user', 'Plan the desk move.', -4_100, '/private/var/empty', desktopMark),
    turn('assistant', 'Planned for the new desk.', -4_000, '/private/var/empty', desktopMark)
  ]), 62_000);

  // A session that was given a folder once and, by the record active last,
  // has none any more.
  const unfiledUuid = 'f3f3f3f3-aaaa-4bbb-8ccc-bbbbbbbbbbb3';
  const again = [turn('user', 'Tidy the notes from the retreat.', -4_500, '/private/var/empty', desktopMark), turn('assistant', 'Tidied, the gecko list is last.', -4_400, '/private/var/empty', desktopMark)];
  for (const at of [one, two]) write(path.join(at, `local_${unfiledUuid}`, '.claude', 'projects', '-private-var-empty', `${UNFILED_ID}.jsonl`), jsonl(again), 72_000);
  write(path.join(one, `local_${unfiledUuid}.json`), record(unfiledUuid, { cliSessionId: UNFILED_ID, title: 'Retreat notes', userSelectedFolders: ['/Users/pat/Retreat'], lastActivityAt: now - 85_000 }));
  write(path.join(two, `local_${unfiledUuid}.json`), record(unfiledUuid, { cliSessionId: UNFILED_ID, title: 'Retreat notes', lastActivityAt: now - 55_000 }));
}

// --- transcripts of a Cowork session that Claude Code's own directory holds
// a newer copy of: the one its record names, and one it does not ---

const claudeBeside = path.join(root, 'claude-beside');
for (const [id, words] of [[COWORK_ID, 'The summary now covers the manatee cohort as well.'], [COWORK_SIDE_ID, 'The quokka note was moved to the appendix.']]) {
  write(path.join(claudeBeside, 'projects', '-sessions-brave-otter', `${id}.jsonl`), jsonl([
    turn('user', 'Carry on.', -900, sandbox, desktopMark),
    turn('assistant', words, -800, sandbox, desktopMark)
  ]), 5_000);
}
// A newer copy of the session whose storage folder has no record at all.
write(path.join(claudeBeside, 'projects', '-sessions-deep', `${COWORK_DEEP_ID}.jsonl`), jsonl([
  turn('user', 'A session nested deeper mentions a pangolin.', -2_000, '/sessions/deep'),
  turn('assistant', 'Noted, and a civet too.', -1_900, '/sessions/deep')
]), 6_000);
// A copy written at the same moment as the app's and holding more.
write(path.join(claudeBeside, 'projects', '-sessions-quiet-heron', `${COWORK_CHAT_ID}.jsonl`), jsonl([
  turn('user', 'Suggest names for a scheduling tool.', -3_000, '/sessions/quiet-heron'),
  turn('assistant', 'How about Tempo, Slate or Meridian?', -2_900, '/sessions/quiet-heron'),
  turn('user', 'One more.', -2_800, '/sessions/quiet-heron'),
  turn('assistant', 'Cadence, like a heron on its rounds.', -2_700, '/sessions/quiet-heron')
]), 40_000);

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key.startsWith('XDG_') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
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
const shortEnv = { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: appShort };

// A home of its own, for running the tool with nothing said about where the
// app keeps its data. Claude Code's directory is moved the way a person
// would move it, which leaves the app's data to be found by itself.
const home = path.join(root, 'home');
const appData = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
const atHome = {
  ...cleanEnv,
  NO_COLOR: '1',
  TZ: 'UTC',
  HOME: home,
  CLAUDE_CONFIG_DIR: claudeDir,
  SESSIONS_CODEX_DIR: path.join(root, 'codex'),
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
};
// The tool finds a home directory through HOME everywhere but on Windows.
const canMoveHome = process.platform !== 'win32';
const homeNote = canMoveHome ? '' : ' (not checked: the home directory cannot be moved here)';
const cli = (args, vars = env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: vars, timeout: 30_000 });
function ok(args, vars = env) {
  const result = cli(args, vars);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.stderr, '', `unexpected stderr from ${args.join(' ')}`);
  return result.stdout;
}
const json = (args, vars = env) => JSON.parse(ok([...args, '--json'], vars));
// A note names a folder the way the tool prints paths: under the home
// directory it starts with ~.
const shown = (folder, homeDir = os.homedir()) => (folder === homeDir || folder.startsWith(homeDir + path.sep) ? `~${folder.slice(homeDir.length)}` : folder);
const byId = (rows, id) => rows.find(row => row.sessionId === id);

console.log('\nwhere the app keeps things');

await test('the data directory follows the platform and can be named or turned off', () => {
  const at = (vars, platform) => desktopDataDir(vars, { home: '/home/pat', platform });
  assert.equal(at({}, 'darwin'), '/home/pat/Library/Application Support/Claude');
  assert.equal(at({}, 'linux'), '/home/pat/.config/Claude');
  assert.equal(at({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), '/cfg/Claude');
  assert.equal(at({ APPDATA: 'C:\\Users\\pat\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\pat\\AppData\\Roaming', 'Claude'));
  assert.equal(at({}, 'win32'), null);
  assert.equal(at({ SESSIONS_CLAUDE_DESKTOP_DIR: '/elsewhere' }, 'darwin'), '/elsewhere');
  assert.equal(at({ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, 'darwin'), null);
  // Moving the Claude directory, as tests do, leaves the real app data alone.
  assert.equal(at({ SESSIONS_CLAUDE_DIR: '/tmp/x' }, 'darwin'), null);
  assert.equal(at({ SESSIONS_CLAUDE_DIR: '/tmp/x', SESSIONS_CLAUDE_DESKTOP_DIR: '/app' }, 'darwin'), '/app');
});

await test('every folder the app may keep its data in is looked at', () => {
  const all = (vars, platform, extra) => desktopDataDirs(vars, { home: '/home/pat', platform, extra });
  // The app has a second data folder, for when it runs on another provider.
  assert.deepEqual(all({}, 'darwin'), ['/home/pat/Library/Application Support/Claude', '/home/pat/Library/Application Support/Claude-3p']);
  assert.deepEqual(all({}, 'linux'), ['/home/pat/.config/Claude', '/home/pat/.config/Claude-3p']);
  assert.deepEqual(all({ XDG_CONFIG_HOME: '/cfg' }, 'linux'), ['/cfg/Claude', '/cfg/Claude-3p']);
  // Windows has more: two roots, a third name, a copy of each inside the
  // package of an install that comes as one, and, for such an install once
  // it has moved its data out of the package, a folder of its own inside
  // Claude-Data, named after the package in lower case.
  const windows = all({ APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, 'win32');
  assert.deepEqual(windows.filter(dir => !dir.includes('Packages')), [
    path.join('C:\\A', 'Claude'), path.join('C:\\L', 'Claude'), path.join('C:\\L', 'Claude-Data'),
    path.join('C:\\L', 'Claude-Data', 'claude_pzs8sxrjxfjjc'), path.join('C:\\L', 'Claude-Data', 'anthropicpbc.claude_fnn82j28hfe8t'),
    path.join('C:\\L', 'Claude-3p'), path.join('C:\\A', 'Claude-3p')
  ]);
  const inPackage = (pkg, kind, name) => path.join('C:\\L', 'Packages', pkg, 'LocalCache', kind, name);
  for (const pkg of ['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t']) {
    for (const [kind, name] of [['Roaming', 'Claude'], ['Local', 'Claude'], ['Local', 'Claude-Data'], ['Local', 'Claude-3p'], ['Roaming', 'Claude-3p']]) {
      assert.equal(windows.includes(inPackage(pkg, kind, name)), true, `${pkg} ${kind} ${name}`);
    }
  }
  assert.equal(windows.length, 17);
  assert.equal(new Set(windows).size, 17);
  assert.equal(all({ LOCALAPPDATA: 'C:\\L' }, 'win32').every(dir => dir.startsWith('C:\\L')), true);
  assert.deepEqual(all({}, 'win32'), []);
  // Folders named in the config file are added to those, once each.
  assert.deepEqual(all({}, 'linux', ['/mnt/profile/Claude', '/home/pat/.config/Claude']),
    ['/home/pat/.config/Claude', '/home/pat/.config/Claude-3p', '/mnt/profile/Claude']);
  // Naming the folder in the environment replaces all of them, and turning
  // the app off or moving the Claude directory leaves none.
  assert.deepEqual(all({ SESSIONS_CLAUDE_DESKTOP_DIR: '/elsewhere' }, 'darwin', ['/mnt/profile/Claude']), ['/elsewhere']);
  assert.deepEqual(all({ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, 'darwin', ['/mnt/profile/Claude']), []);
  assert.deepEqual(all({ SESSIONS_CLAUDE_DIR: '/tmp/x' }, 'darwin', ['/mnt/profile/Claude']), []);
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
  // Every transcript the session has had, the current one first and once.
  assert.deepEqual(code.transcriptIds, ['abc']);
  assert.deepEqual(desktopRecord({ cliSessionId: 'now', previousCliSessionIds: ['first', 7, 'now', ' second '] }, 'cowork').transcriptIds, ['now', 'first', 'second']);
  assert.deepEqual(desktopRecord({ previousCliSessionIds: 'first' }, 'cowork').transcriptIds, []);
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
  // A folder named outright is expected to be there and to be the app's.
  // When it is not, the sessions in it are missing, and that is said.
  const emptyFolder = path.join(root, 'not-app-data');
  mkdirSync(emptyFolder, { recursive: true });
  const aFile = write(path.join(root, 'a-file-not-a-folder'), 'x');
  for (const [folder, reason] of [
    [path.join(root, 'no-such-app'), 'not found'],
    [emptyFolder, 'not a data folder of the Claude desktop app'],
    [aFile, 'not a folder']
  ]) {
    const result = cli(['list', '--json'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: folder });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).length, OWN_IDS.length);
    assert.equal(result.stderr, `Could not read ${shown(folder)} (${reason}); sessions there are left out.\n`);
  }
  // Only sessions show that a named folder is the right one. A folder with
  // some other program's settings is not the app's. One with the app's own
  // settings file and no session is the app's, and still cannot be told
  // from the wrong profile: it is said, and it holds back a prune.
  const other = path.join(root, 'app-other-program');
  write(path.join(other, 'config.json'), {});
  const fresh = path.join(root, 'app-fresh');
  write(path.join(fresh, 'claude_desktop_config.json'), {});
  for (const [folder, reason] of [[other, 'not a data folder of the Claude desktop app'], [fresh, 'no sessions of the Claude desktop app in it']]) {
    const vars = { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: folder };
    const result = cli(['list', '--json'], vars);
    assert.equal(result.stderr, `Could not read ${shown(folder)} (${reason}); sessions there are left out.\n`);
    assert.equal(JSON.parse(result.stdout).length, OWN_IDS.length);
    const pruning = cli(['sync', '--prune', '--dry-run'], vars);
    assert.equal(pruning.status, 1, folder);
    assert.match(pruning.stderr, /Not pruning: 1 folder could not be read/);
  }
  // The app's two session folders, both empty, say no more than that.
  const hollow = path.join(root, 'app-hollow');
  mkdirSync(path.join(hollow, 'local-agent-mode-sessions', 'acct', 'org'), { recursive: true });
  mkdirSync(path.join(hollow, 'claude-code-sessions'), { recursive: true });
  const none = cli(['list', '--json'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: hollow });
  assert.equal(none.stderr, `Could not read ${shown(hollow)} (no sessions of the Claude desktop app in it); sessions there are left out.\n`);
  assert.equal(cli(['sync', '--prune', '--dry-run'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: hollow }).status, 1);
  // Nor does a Cowork storage folder with nothing in it.
  const bare = path.join(root, 'app-bare');
  mkdirSync(path.join(bare, 'local-agent-mode-sessions', 'acct', 'org', 'local_x', '.claude', 'projects', '-private-var-empty'), { recursive: true });
  write(path.join(bare, 'local-agent-mode-sessions', 'acct', 'org', 'local_x.json'), { sessionId: 'local_x', title: 'Never started' });
  const nothing = cli(['list', '--json'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: bare });
  assert.equal(nothing.stderr, `Could not read ${shown(bare)} (no sessions of the Claude desktop app in it); sessions there are left out.\n`);
  assert.equal(cli(['sync', '--prune', '--dry-run'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: bare }).status, 1);
  // A folder that holds only Code tab records is the app's.
  const codeOnly = path.join(root, 'app-code-only');
  write(path.join(codeOnly, 'claude-code-sessions', 'acct', 'org', 'local_x.json'), { sessionId: 'local_x', cliSessionId: PLAIN_ID, title: 'Open pull requests' });
  const read = cli(['list', '--json'], { ...env, SESSIONS_CLAUDE_DESKTOP_DIR: codeOnly });
  assert.equal(read.stderr, '');
  assert.equal(byId(JSON.parse(read.stdout), PLAIN_ID).title, 'Open pull requests');
});

await test('why a named folder cannot be used is told apart', async () => {
  assert.equal(await namedFolderTrouble(appDir), null);
  assert.equal(await namedFolderTrouble(path.join(root, 'nowhere')), 'not found');
  assert.equal(await namedFolderTrouble(path.join(root, 'a-file-not-a-folder')), 'not a folder');
  assert.equal(await namedFolderTrouble(path.join(root, 'not-app-data')), 'not a data folder of the Claude desktop app');
  assert.equal(await namedFolderTrouble(path.join(root, 'app-other-program')), 'not a data folder of the Claude desktop app');
  assert.equal(await namedFolderTrouble(path.join(root, 'app-fresh')), 'no sessions of the Claude desktop app in it');
  assert.equal(await namedFolderTrouble(path.join(root, 'app-code-only')), null);
  // What the config file names is named, a usual folder included: whoever
  // wrote it down expects sessions there. The folder the environment names
  // is the only named one when there is one, and a moved Claude directory
  // leaves none.
  const usual = '/home/pat/Library/Application Support/Claude-3p';
  assert.deepEqual(namedDesktopDirs({}, { extra: [usual, '/mnt/profile/Claude', usual] }), [usual, '/mnt/profile/Claude']);
  assert.deepEqual(namedDesktopDirs({}), []);
  assert.deepEqual(namedDesktopDirs({ SESSIONS_CLAUDE_DESKTOP_DIR: '/elsewhere' }, { extra: ['/mnt/x'] }), ['/elsewhere']);
  assert.deepEqual(namedDesktopDirs({ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, { extra: ['/mnt/x'] }), []);
  assert.deepEqual(namedDesktopDirs({ SESSIONS_CLAUDE_DIR: '/tmp/x' }, { extra: ['/mnt/x'] }), []);
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
  // A session given a folder is filed under it. One given none ran in the
  // app's own place, and says so; no other kind of session carries the mark.
  assert.equal('noProject' in cw, false);
  assert.deepEqual([chat.noProject, deep.noProject], [true, true]);
  assert.deepEqual(sessions.filter(session => !session.app && 'noProject' in session), []);
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

console.log('\nhowever the app names and places its folders');

await test('a storage folder named with the start of its session id is paired with the record', async () => {
  const found = new Map((await findCoworkSessions(appShort)).map(entry => [path.relative(coworkShort, entry.storageDir), entry.record]));
  assert.deepEqual([...found.keys()].sort(), ['5a5a5a5a', '6b6b6b6b', '9e9e9e9e', 'abababab', path.join('agent', 'aeaeaeae'), 'kept-from-before', `local_${pairFull}`, 'storage-17'].sort());
  // A folder that holds a transcript the session had before is that
  // session's too, though the record already has its own folder.
  assert.equal(found.get('kept-from-before'), found.get('5a5a5a5a'));
  // Eight characters are not a name. A record that begins like the folder
  // and lists a transcript the folder does not hold is another session's.
  assert.deepEqual([found.get('abababab').title, found.get('abababab').archived, found.get('abababab').folders], [null, false, []]);
  assert.deepEqual([found.get('5a5a5a5a').title, found.get('5a5a5a5a').transcriptId, found.get('5a5a5a5a').folders], ['Budget review notes', SHORT_ID, ['/Users/pat/Budget']]);
  assert.deepEqual([found.get(path.join('agent', 'aeaeaeae')).title, found.get(path.join('agent', 'aeaeaeae')).archived], ['Inbox triage', true]);
  // Two sessions that begin alike: the short folder belongs to the one whose
  // transcript it holds, and the full-named folder to its namesake.
  assert.equal(found.get('6b6b6b6b').title, 'Offsite agenda');
  assert.equal(found.get(`local_${pairFull}`).title, 'Vendor shortlist');
  // A folder named like nothing is paired by the transcripts its record lists.
  assert.equal(found.get('storage-17').title, 'Hiring plan');
  // No record: still a session, with no name. A file that is not a session's
  // record is not taken for one, whatever it says.
  assert.deepEqual([found.get('9e9e9e9e').title, found.get('9e9e9e9e').kind, found.get('9e9e9e9e').transcriptIds], [null, 'cowork', []]);
});

await test(`a record that is a link, or has a namesake that is no record, is still the record${canLink ? '' : ' (links not checked: they cannot be made here)'}`, async () => {
  const found = new Map((await findCoworkSessions(appOdd)).map(entry => [path.basename(entry.storageDir), entry.record]));
  // A file that only shares the folder's name does not stand in for the
  // record that lists the folder's transcript.
  assert.deepEqual([found.get('c1c1c1c1').title, found.get('c1c1c1c1').transcriptId], ['Lease comparison', NAMESAKE_ID]);
  // A record need not repeat inside which session it is when its name is
  // the session's id.
  const unsigned = found.get(`local_${unsignedUuid}`);
  assert.deepEqual([unsigned.title, unsigned.desktopId, unsigned.folders], ['Venue booking', `local_${unsignedUuid}`, ['/Users/pat/Events']]);
  if (canLink) assert.deepEqual([found.get('b1b1b1b1').title, found.get('b1b1b1b1').transcriptId], ['Office move plan', LINKED_ID]);
  const sessions = json(['list', '-n', '100'], { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: appOdd });
  assert.equal(byId(sessions, NAMESAKE_ID).title, 'Lease comparison');
  if (canLink) assert.equal(byId(sessions, LINKED_ID).title, 'Office move plan');
  // Given no folder, it ran in no project, and so did what its subagent did.
  const withAgents = json(['list', '-n', '100', '--subagents'], { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: appOdd });
  assert.deepEqual([byId(withAgents, NAMESAKE_ID).noProject, byId(withAgents, ODD_AGENT).noProject], [true, true]);
  // A subagent of a session that was given a folder is filed with it.
  const reported = json(['list', '-n', '100', '--subagents']);
  assert.deepEqual([byId(reported, COWORK_AGENT).project, 'noProject' in byId(reported, COWORK_AGENT)], ['/Users/pat/Reports', false]);
});

await test('those sessions are listed with their names and folders', () => {
  const sessions = json(['list', '-n', '100'], shortEnv);
  assert.deepEqual(sessions.filter(session => session.app).map(session => session.sessionId).sort(), [...SHORT_IDS].sort());
  const brief = id => { const session = byId(sessions, id); return [session.app, session.desktopKind, session.title || null, session.named === true, session.project]; };
  assert.deepEqual(brief(SHORT_ID), ['desktop', 'cowork', 'Budget review notes', true, '/Users/pat/Budget']);
  assert.deepEqual(brief(EARLIER_ID), ['desktop', 'cowork', 'Budget review notes', true, '/Users/pat/Budget']);
  assert.deepEqual(brief(PAIR_SHORT_ID), ['desktop', 'cowork', 'Offsite agenda', true, '/private/var/empty']);
  assert.deepEqual(brief(PAIR_FULL_ID), ['desktop', 'cowork', 'Vendor shortlist', true, '/private/var/empty']);
  assert.deepEqual(brief(STRAY_ID), ['desktop', 'cowork', null, false, '/private/var/empty']);
  assert.equal(byId(sessions, AGENT_ID).archived, true);
  // The transcript a session had before its current one is that session too.
  assert.deepEqual([brief(MOVED_ID)[2], brief(MOVED_OLD_ID)[2]], ['Hiring plan', 'Hiring plan']);
  // Both transcripts of that session answer to its name.
  assert.deepEqual(json(['search', 'budget review notes'], shortEnv).map(row => [row.sessionId, row.type]).sort(), [[SHORT_ID, 'title'], [EARLIER_ID, 'title']].sort());
  assert.equal(json(['search', 'okapi'], shortEnv)[0].title, 'Budget review notes');
  assert.match(ok(['show', SHORT_ID], shortEnv), /^Title: Budget review notes\nApp: Claude desktop \(Cowork\)$/m);
});

await test(`the app's second data folder is found with nothing set up${homeNote}`, () => {
  if (!canMoveHome) return;
  // As on a machine where the app runs on another provider: its usual folder
  // is there and empty, and the sessions are in the other one.
  mkdirSync(path.join(appData, 'Claude'), { recursive: true });
  assert.equal(json(['list', '-n', '100'], atHome).some(session => session.app), false);
  symlinkSync(appShort, path.join(appData, 'Claude-3p'), 'dir');
  try {
    const sessions = json(['list', '-n', '100'], atHome);
    assert.deepEqual(sessions.filter(session => session.app).map(session => session.sessionId).sort(), [...SHORT_IDS].sort());
    assert.equal(sessions.length, OWN_IDS.length + SHORT_IDS.length);
    assert.equal(byId(sessions, SHORT_ID).title, 'Budget review notes');
    assert.equal(json(['search', 'kakapo'], atHome)[0].sessionId, AGENT_ID);
    // Both folders in use at once: the sessions of each are listed.
    rmSync(path.join(appData, 'Claude'), { recursive: true });
    symlinkSync(appDir, path.join(appData, 'Claude'), 'dir');
    const both = json(['list', '-n', '100'], atHome);
    assert.equal(both.length, OWN_IDS.length + 7 + SHORT_IDS.length);
    assert.equal(byId(both, COWORK_ID).title, 'Quarterly report draft');
    assert.equal(byId(both, CODE_ID).app, 'desktop');
  } finally {
    rmSync(path.join(appData, 'Claude'), { recursive: true, force: true });
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
});

await test(`two sessions that only share a folder name in two data folders are both listed${homeNote}`, () => {
  if (!canMoveHome) return;
  symlinkSync(twinDirs[0], path.join(appData, 'Claude'), 'dir');
  symlinkSync(twinDirs[1], path.join(appData, 'Claude-3p'), 'dir');
  try {
    const titles = vars => json(['list', '-n', '100'], vars).filter(session => session.app).map(session => [session.sessionId, session.title]).sort();
    assert.deepEqual(titles(atHome), [[TWIN_ONE_ID, 'Travel booking'], [TWIN_TWO_ID, 'Expense report']]);
    // A third folder that holds a copy of the second: still two sessions.
    const file = path.join(root, 'paths-third.yaml');
    const third = path.join(root, 'third-copy', 'Claude');
    mkdirSync(path.dirname(third), { recursive: true });
    symlinkSync(twinDirs[1], third, 'dir');
    writeFileSync(file, `paths:\n  claude_desktop: ${JSON.stringify(third)}\n`);
    assert.deepEqual(titles({ ...atHome, SESSIONS_CONFIG: file }), [[TWIN_ONE_ID, 'Travel booking'], [TWIN_TWO_ID, 'Expense report']]);
  } finally {
    rmSync(path.join(appData, 'Claude'), { recursive: true, force: true });
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
});

await test(`a session kept in two data folders is one session, and nothing either copy holds is lost${homeNote}`, () => {
  if (!canMoveHome) return;
  symlinkSync(copyDirs[0], path.join(appData, 'Claude'), 'dir');
  symlinkSync(copyDirs[1], path.join(appData, 'Claude-3p'), 'dir');
  try {
    const sessions = json(['list', '-n', '100'], atHome).filter(session => session.app);
    // The transcript both hold is listed once, from the copy written last,
    // whatever each folder is called. The one only the older copy holds is
    // still there.
    assert.deepEqual(sessions.map(session => session.sessionId).sort(), [KEPT_BEFORE_ID, KEPT_ID]);
    const kept = byId(sessions, KEPT_ID);
    assert.equal(kept.title, 'Supplier audit, signed off');
    assert.equal(kept.filePath.includes('app-copy-new') || kept.filePath.includes('Claude-3p'), true, kept.filePath);
    assert.equal(byId(sessions, KEPT_BEFORE_ID).title, 'Supplier audit');
    // Its full id opens it: two copies are not two sessions to choose from.
    const opened = cli(['show', `claude:${KEPT_ID}`], atHome);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /quoll report/);
    assert.equal(json(['search', 'quoll'], atHome).length, 1);
    assert.equal(json(['search', 'pika'], atHome)[0].sessionId, KEPT_BEFORE_ID);
    // Counted once where sessions are counted.
    const filed = json(['projects', '--source', 'claude'], atHome).find(project => project.path === '/private/var/empty');
    assert.equal(filed.sessionCount, 2);
    assert.match(ok(['sync', '--dry-run'], atHome), new RegExp(`^Would index ${OWN_IDS.length + 2} sessions, `));
  } finally {
    rmSync(path.join(appData, 'Claude'), { recursive: true, force: true });
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
});

await test(`what the app knows about a session comes with it to whichever copy stands for it${homeNote}`, () => {
  if (!canMoveHome) return;
  symlinkSync(tieDirs[0], path.join(appData, 'Claude'), 'dir');
  symlinkSync(tieDirs[1], path.join(appData, 'Claude-3p'), 'dir');
  try {
    const all = json(['list', '-n', '100', '--subagents'], atHome);
    const sessions = all.filter(session => session.app && !session.subagent);
    assert.deepEqual(sessions.map(session => session.sessionId).sort(), [TIED_ID, STRAY_COPY_ID, UNFILED_ID, SOLE_COPY_ID, REFILED_ID].sort());
    // Two copies written at the same moment: the record that was active
    // later speaks for the session, with its name, its folder and its state.
    const tied = byId(sessions, TIED_ID);
    assert.deepEqual([tied.title, tied.project, tied.archived, 'noProject' in tied], ['Ledger reconciled', '/Users/pat/Ledger', true, false]);
    // The newer copy is in a folder with no record: it is the one read, and
    // it is still the session the other folder's record describes.
    const stray = byId(sessions, STRAY_COPY_ID);
    assert.deepEqual([stray.title, stray.project, stray.desktopKind, 'noProject' in stray], ['Launch plan', '/Users/pat/Plans', 'cowork', false]);
    assert.equal(stray.filePath.includes('recovered-folder'), true, stray.filePath);
    assert.equal(json(['search', 'dugong'], atHome)[0].sessionId, STRAY_COPY_ID);
    // What a subagent left is found beside either copy, the one passed over
    // included, and is filed where the session it worked for is.
    const agents = all.filter(session => session.subagent).map(session => [session.sessionId, session.parentSessionId, session.project, 'noProject' in session]).sort();
    assert.deepEqual(agents, [
      [TIE_AGENT, STRAY_COPY_ID, '/Users/pat/Plans', false],
      [TIE_AGENT_TWO, STRAY_COPY_ID, '/Users/pat/Plans', false],
      [REFILED_AGENT, REFILED_ID, '/Users/pat/NewDesk', false]
    ]);
    assert.equal(json(['search', 'wombat dependency'], atHome)[0].sessionId, TIE_AGENT);
    assert.match(ok(['sync', '--dry-run'], atHome), new RegExp(`^Would index ${OWN_IDS.length + 8} sessions, `));
    // A record that lists no transcript speaks for the one its folder held:
    // the newer copy, in a folder without a record, keeps the session's
    // name, folder and state.
    const sole = byId(sessions, SOLE_COPY_ID);
    assert.deepEqual([sole.title, sole.project, sole.archived, 'noProject' in sole], ['Invoice run', '/Users/pat/Invoices', true, false]);
    assert.equal(sole.filePath.includes('recovered-too'), true, sole.filePath);
    // How a session is filed is not part of what is reported.
    assert.equal(all.some(session => 'filedByRecord' in session), false);
    // The record active last says the session has no folder any more: it is
    // filed where it ran, not under the folder an older record gave it.
    const unfiled = byId(sessions, UNFILED_ID);
    assert.deepEqual([unfiled.title, unfiled.project, unfiled.noProject], ['Retreat notes', '/private/var/empty', true]);
    // A filter by project looks at where a session is filed, which is not
    // always where the copy that stands for it sits.
    const filtered = args => json(['list', '-n', '100', ...args], atHome).map(session => session.sessionId).sort();
    assert.deepEqual(filtered(['-p', 'Plans']), [STRAY_COPY_ID]);
    assert.deepEqual(filtered(['-p', 'Plans', '--subagents']), [TIE_AGENT, TIE_AGENT_TWO, STRAY_COPY_ID].sort());
    assert.deepEqual(filtered(['-p', 'Ledger']), [TIED_ID]);
    assert.deepEqual(filtered(['-p', 'Retreat']), []);
    // A session given another folder since is found under the new one, and
    // so is what its subagent left beside the older copy; the old folder
    // has neither, with or without subagents asked for.
    assert.deepEqual(filtered(['-p', 'NewDesk', '--subagents']), [REFILED_AGENT, REFILED_ID].sort());
    assert.deepEqual(filtered(['-p', 'OldDesk', '--subagents']), []);
    assert.deepEqual(filtered(['-p', 'OldDesk']), []);
    assert.deepEqual(json(['search', 'tapir wide', '-p', 'OldDesk'], atHome), []);
    assert.equal(json(['search', 'tapir wide', '-p', 'NewDesk'], atHome)[0].sessionId, REFILED_AGENT);
    assert.deepEqual(json(['search', 'dugong', '-p', 'Plans'], atHome).map(row => row.sessionId), [STRAY_COPY_ID]);
    // A folder left with nothing of its own is not a project, and each
    // session is counted under the folder it is filed under.
    const projects = json(['projects', '--source', 'claude'], atHome);
    assert.deepEqual(projects.filter(project => project.sessionCount <= 0), []);
    assert.equal(projects.find(project => project.path === '/Users/pat/Plans').sessionCount, 1);
    assert.equal(projects.some(project => project.path === '/Users/pat/Retreat'), false);
  } finally {
    rmSync(path.join(appData, 'Claude'), { recursive: true, force: true });
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
});

await test(`a newer copy under Claude Code's own directory keeps what the app knows, and no more${homeNote}`, () => {
  if (!canMoveHome) return;
  symlinkSync(appDir, path.join(appData, 'Claude'), 'dir');
  try {
    const sessions = json(['list', '-n', '100'], { ...atHome, CLAUDE_CONFIG_DIR: claudeBeside });
    // Each is listed once, from the newer copy.
    for (const id of [COWORK_ID, COWORK_SIDE_ID]) {
      assert.equal(sessions.filter(session => session.sessionId === id).length, 1, id);
      assert.equal(byId(sessions, id).filePath.startsWith(claudeBeside), true, id);
    }
    // The transcript the record names keeps the session's name, tab and folder.
    const named = byId(sessions, COWORK_ID);
    assert.deepEqual([named.app, named.desktopKind, named.title, named.project], ['desktop', 'cowork', 'Quarterly report draft', '/Users/pat/Reports']);
    // Its sibling belongs to the same session and is not what the record
    // names: it does not take the session's name.
    const sibling = byId(sessions, COWORK_SIDE_ID);
    assert.deepEqual([sibling.app, sibling.desktopKind, 'title' in sibling, sibling.project], ['desktop', 'cowork', false, '/Users/pat/Reports']);
    assert.equal(json(['search', 'manatee'], { ...atHome, CLAUDE_CONFIG_DIR: claudeBeside })[0].title, 'Quarterly report draft');
    // A transcript whose storage folder has no record is still a Cowork
    // session's, and still one that ran in no project.
    const recordless = byId(sessions, COWORK_DEEP_ID);
    assert.deepEqual([recordless.app, recordless.desktopKind, recordless.noProject, 'title' in recordless], ['desktop', 'cowork', true, false]);
    assert.equal(recordless.filePath.startsWith(claudeBeside), true);
    // Two copies written at the same moment: the one that holds more.
    const longer = byId(sessions, COWORK_CHAT_ID);
    assert.equal(longer.filePath.startsWith(claudeBeside), true, longer.filePath);
    assert.deepEqual([longer.desktopKind, longer.title], ['chat', 'Naming ideas']);
    assert.equal(json(['search', 'Cadence heron'], { ...atHome, CLAUDE_CONFIG_DIR: claudeBeside })[0].sessionId, COWORK_CHAT_ID);
  } finally {
    rmSync(path.join(appData, 'Claude'), { recursive: true, force: true });
  }
});

await test(`run from inside a Cowork session, the tool lists that session once${homeNote}`, () => {
  if (!canMoveHome) return;
  // The app runs Claude Code with its directory set to the session's own
  // storage, so the session's transcripts are found there and among the
  // app's data alike.
  symlinkSync(appShort, path.join(appData, 'Claude-3p'), 'dir');
  try {
    const inside = { ...atHome, CLAUDE_CONFIG_DIR: path.join(coworkShort, '5a5a5a5a', '.claude') };
    const sessions = json(['list', '-n', '100'], inside);
    assert.deepEqual(sessions.map(session => session.sessionId).sort(), [...SHORT_IDS].sort());
    const own = byId(sessions, SHORT_ID);
    assert.deepEqual([own.app, own.desktopKind, own.title, own.project], ['desktop', 'cowork', 'Budget review notes', '/Users/pat/Budget']);
    const opened = cli(['show', SHORT_ID], inside);
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /okapi line/);
    assert.equal(json(['search', 'okapi'], inside).length, 1);
    assert.equal(json(['projects', '--source', 'claude'], inside).reduce((sum, project) => sum + project.sessionCount, 0), SHORT_IDS.length);
    assert.match(ok(['sync', '--dry-run'], inside), new RegExp(`^Would index ${SHORT_IDS.length} sessions, `));
  } finally {
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
});

await test('the config file can name more folders to look in', async () => {
  const file = path.join(root, 'paths.yaml');
  const read = async text => {
    writeFileSync(file, text);
    return (await loadConfig({ env: { SESSIONS_CONFIG: file }, home: '/home/pat' })).paths;
  };
  // One folder or a list; ~ is the home directory; a folder written twice,
  // with and without its closing separator, is there once.
  const at = (...parts) => path.resolve(path.join(...parts));
  assert.deepEqual(await read('paths:\n  claude_desktop: /mnt/profile/Claude\n'), { claudeDesktop: [at('/mnt/profile/Claude')], warnings: [] });
  assert.deepEqual((await read('paths:\n  claude_desktop:\n    - ~/Library/Application Support/Claude-3p\n    - /mnt/profile/Claude/\n    - /mnt/profile/Claude\n    - /mnt/profile/../profile/Claude\n')).claudeDesktop,
    [at('/home/pat/Library/Application Support/Claude-3p'), at('/mnt/profile/Claude')]);
  assert.deepEqual((await read('paths:\n  claudeDesktop: "~"\n')).claudeDesktop, [at('/home/pat')]);
  // A place has to be named in full. What is not is left out and said.
  const odd = await read('paths:\n  claude_desktop:\n    - profile/Claude\n    - 7\n    - /mnt/ok\n');
  assert.deepEqual(odd.claudeDesktop, [at('/mnt/ok')]);
  assert.deepEqual(odd.warnings, [
    'Ignoring paths.claude_desktop entry "profile/Claude": it has to be a full path to a folder',
    'Ignoring paths.claude_desktop entry 7: it has to be a full path to a folder'
  ]);
  // Nothing there is no folders and no complaint.
  for (const text of ['', 'paths:\n', 'paths:\n  claude_desktop:\n', 'elasticsearch:\n  url: http://127.0.0.1:9200\n']) {
    assert.deepEqual(await read(text), { claudeDesktop: [], warnings: [] }, JSON.stringify(text));
  }
  assert.deepEqual((await loadConfig({ env: { SESSIONS_CONFIG: path.join(root, 'absent.yaml') } })).paths, { claudeDesktop: [], warnings: [] });
  // Something there that cannot be used is said: a place that is silently
  // not looked in reads as "no sessions there".
  assert.deepEqual(await read('paths: [/mnt/profile/Claude]\n'), { claudeDesktop: [], warnings: ['Ignoring paths: it takes named entries, and the one there is claude_desktop'] });
  assert.deepEqual(await read('paths: /mnt/profile/Claude\n'), { claudeDesktop: [], warnings: ['Ignoring paths: it takes named entries, and the one there is claude_desktop'] });
  assert.deepEqual(await read('paths:\n  claude-desktop: /mnt/profile/Claude\n'), { claudeDesktop: [], warnings: ['Ignoring paths.claude-desktop: the one entry paths takes is claude_desktop'] });
  // An entry that refers to itself cannot be shown, and stops nothing.
  const loop = await read('paths:\n  claude_desktop: &again\n    - *again\n    - /mnt/ok\n');
  assert.deepEqual(loop.claudeDesktop, [at('/mnt/ok')]);
  assert.deepEqual(loop.warnings, ['Ignoring paths.claude_desktop entry a value that cannot be shown: it has to be a full path to a folder']);
  // A file that cannot be read at all says so apart from its settings.
  writeFileSync(file, 'paths: [unclosed\n');
  const broken = await loadConfig({ env: { SESSIONS_CONFIG: file } });
  assert.match(broken.fileWarning, /^Ignoring .*paths\.yaml: /);
  assert.equal(broken.warning, broken.fileWarning);
  assert.deepEqual(broken.paths, { claudeDesktop: [], warnings: [] });
  assert.equal((await loadConfig({ env: { SESSIONS_CONFIG: path.join(root, 'absent.yaml'), SESSIONS_SEARCH_BACKEND: 'bogus' } })).fileWarning, null);
});

await test(`folders named in the config file are read along with the usual ones${homeNote}`, () => {
  if (!canMoveHome) return;
  const file = path.join(root, 'paths-used.yaml');
  const elsewhere = path.join(root, 'profile with spaces', 'Claude');
  mkdirSync(path.dirname(elsewhere), { recursive: true });
  symlinkSync(appShort, elsewhere, 'dir');
  writeFileSync(file, `paths:\n  claude_desktop:\n    - ${JSON.stringify(elsewhere)}\n    - not/a/full/path\n`);
  const vars = { ...atHome, SESSIONS_CONFIG: file };
  const listed = cli(['list', '-n', '100', '--json'], vars);
  assert.equal(listed.status, 0, listed.stderr);
  // The entry that cannot be used is named once; the rest is read.
  assert.equal(listed.stderr, 'Ignoring paths.claude_desktop entry "not/a/full/path": it has to be a full path to a folder\n');
  const sessions = JSON.parse(listed.stdout);
  assert.deepEqual(sessions.filter(session => session.app).map(session => session.sessionId).sort(), [...SHORT_IDS].sort());
  // The same sessions in a usual folder as well are one set of sessions.
  symlinkSync(appShort, path.join(appData, 'Claude-3p'), 'dir');
  try {
    const twice = cli(['list', '-n', '100', '--json'], vars);
    assert.equal(JSON.parse(twice.stdout).filter(session => session.app).length, SHORT_IDS.length);
  } finally {
    rmSync(path.join(appData, 'Claude-3p'), { recursive: true, force: true });
  }
  // A folder named in the environment is read instead of all of those. With
  // the app turned off, or the Claude directory moved, none is read. In all
  // three the file's paths do not count, so nothing is said about them.
  const instead = cli(['list', '-n', '100', '--json'], { ...vars, SESSIONS_CLAUDE_DESKTOP_DIR: appDir });
  assert.equal(instead.stderr, '');
  assert.deepEqual(JSON.parse(instead.stdout).filter(session => session.app).map(session => session.sessionId).filter(id => SHORT_IDS.includes(id)), []);
  assert.equal(byId(JSON.parse(instead.stdout), COWORK_ID).title, 'Quarterly report draft');
  for (const override of [{ SESSIONS_CLAUDE_DESKTOP_DIR: '' }, { SESSIONS_CLAUDE_DIR: claudeDir }]) {
    const without = cli(['list', '-n', '100', '--json'], { ...vars, ...override });
    assert.equal(without.status, 0, without.stderr);
    assert.equal(without.stderr, '', JSON.stringify(override));
    assert.equal(JSON.parse(without.stdout).some(session => session.app), false, JSON.stringify(override));
  }
});

await test(`a folder the config file names and that is not there is said, and never pruned${homeNote}`, () => {
  if (!canMoveHome) return;
  const file = path.join(root, 'paths-gone.yaml');
  const gone = path.join(root, 'unplugged drive', 'Claude');
  writeFileSync(file, `paths:\n  claude_desktop: ${JSON.stringify(gone)}\n`);
  const vars = { ...atHome, SESSIONS_CONFIG: file };
  const listed = cli(['list', '-n', '100', '--json'], vars);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stderr, `Could not read ${shown(gone, home)} (not found); sessions there are left out.\n`);
  assert.equal(JSON.parse(listed.stdout).length, OWN_IDS.length);
  // Sessions in a folder that is away for now are not sessions that were deleted.
  const pruning = cli(['sync', '--prune', '--dry-run'], vars);
  assert.equal(pruning.status, 1);
  assert.match(pruning.stderr, /Not pruning: 1 folder could not be read .*, so sessions in them would look deleted/);
  // The same for a folder that is there and is not the app's: the place a
  // drive is mounted at while the drive is away, or a mistyped path.
  mkdirSync(gone, { recursive: true });
  const empty = cli(['list', '-n', '100', '--json'], vars);
  assert.equal(empty.stderr, `Could not read ${shown(gone, home)} (not a data folder of the Claude desktop app); sessions there are left out.\n`);
  assert.equal(cli(['sync', '--prune', '--dry-run'], vars).status, 1);
  // Once it holds the app's data it is read, and nothing is said.
  rmSync(gone, { recursive: true });
  symlinkSync(appShort, gone, 'dir');
  const back = cli(['list', '-n', '100', '--json'], vars);
  assert.equal(back.stderr, '');
  assert.equal(JSON.parse(back.stdout).filter(session => session.app).length, SHORT_IDS.length);
  assert.equal(cli(['sync', '--prune', '--dry-run'], vars).status, 0);
  // The usual folders are often not there, and nothing is said about those.
  // One of them that the config file names is expected like any named one.
  assert.equal(cli(['list'], atHome).stderr, '');
  assert.equal(cli(['sync', '--prune', '--dry-run'], atHome).status, 0);
  const usual = path.join(appData, 'Claude-3p');
  writeFileSync(file, `paths:\n  claude_desktop: ${JSON.stringify(usual)}\n`);
  assert.equal(cli(['list'], vars).stderr, `Could not read ${shown(usual, home)} (not found); sessions there are left out.\n`);
  assert.equal(cli(['sync', '--prune', '--dry-run'], vars).status, 1);
});

await test(`a config file that cannot be read is said by every command that reads it, once${homeNote}`, () => {
  if (!canMoveHome) return;
  const file = path.join(root, 'broken.yaml');
  writeFileSync(file, 'paths:\n  claude_desktop: [unclosed\n');
  const vars = { ...atHome, SESSIONS_CONFIG: file };
  for (const args of [['list'], ['search', 'pull requests'], ['projects']]) {
    const result = cli(args, vars);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    const lines = result.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(lines[0], /^Ignoring .*broken\.yaml: /, args.join(' '));
  }
  // While the file cannot be used, the folders it meant to name are not
  // looked in, and their sessions are missing, not deleted.
  const pruning = cli(['sync', '--prune', '--dry-run'], vars);
  assert.equal(pruning.status, 1);
  assert.match(pruning.stderr, /Not pruning: the config file could not be used as written \(Ignoring .*broken\.yaml: .*\), so sessions in the folders it names would look deleted/);
  assert.equal(cli(['sync', '--dry-run'], vars).status, 0);
  // A setting under "paths" that cannot be used, likewise.
  writeFileSync(file, 'paths:\n  claude-desktop: /mnt/profile/Claude\n');
  assert.equal(cli(['list'], vars).stderr, 'Ignoring paths.claude-desktop: the one entry paths takes is claude_desktop\n');
  assert.equal(cli(['sync', '--prune', '--dry-run'], vars).status, 1);
  // With the file in order, pruning goes ahead.
  writeFileSync(file, 'search:\n  backend: auto\n');
  const fine = cli(['sync', '--prune', '--dry-run'], vars);
  assert.equal(fine.status, 0, fine.stderr);
  assert.equal(fine.stderr, '');
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
  // A folder named outright that cannot be looked into says why.
  const sealed = path.join(root, 'app-sealed');
  write(path.join(sealed, 'local-agent-mode-sessions', 'acct', 'org', 'x.json'), {});
  const locks = [[slug, 0o000], [closed, 0o000], [listable, 0o444], [sealed, 0o000]];
  for (const [folder, mode] of locks) chmodSync(folder, mode);
  try {
    const refused = cli(['list', '--json'], { ...withoutApp, SESSIONS_CLAUDE_DESKTOP_DIR: sealed });
    assert.equal(refused.status, 0, refused.stderr);
    assert.equal(refused.stderr, `Could not read ${shown(sealed)} (EACCES); sessions there are left out.\n`);
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
