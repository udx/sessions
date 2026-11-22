#!/usr/bin/env node

// Tests for what gets read from disk: Claude subagent transcripts, compressed
// Codex rollouts, forked rollouts, and the JSONL line reader. Hermetic: every
// transcript is written to a temporary directory.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { createFrameWatch } from '../lib/zstd-frames.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-transcripts-'));
const claudeDir = path.join(root, 'claude');
const codexDir = path.join(root, 'codex');
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();

let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31mx\x1b[0m ${name}`);
    console.log(`    ${String(error.message).split('\n').slice(0, 8).join('\n    ')}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`  \x1b[33m-\x1b[0m ${name} (skipped: ${why})`);
}

function write(file, text, ageMs = 60_000) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  const date = new Date(now - ageMs);
  utimesSync(file, date, date);
  return file;
}
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

function claude(type, content, offset, extra = {}) {
  return {
    type,
    cwd: '/work/app',
    timestamp: iso(offset),
    ...extra,
    message: {
      role: type,
      model: type === 'assistant' ? 'claude-test' : undefined,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content
    }
  };
}

// --- Claude: a session, its subagents, a workflow, and a second parent ---

const PARENT = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const AGENT = 'a1111111111111111';
const WORKFLOW_AGENT = 'a2222222222222222';
const COPIED_AGENT = 'a3333333333333333';
const project = path.join(claudeDir, 'projects', '-work-app');
const SEPARATOR = String.fromCharCode(0x2028);

write(path.join(project, `${PARENT}.jsonl`), jsonl([
  claude('user', 'Audit the billing module for rounding errors.', -9_000),
  claude('assistant', [
    { type: 'text', text: 'Delegating the audit.' },
    { type: 'tool_use', name: 'Agent', input: { description: 'Billing audit', prompt: 'Check rounding in invoices.' } }
  ], -8_900),
  claude('assistant', `Pasted text keeps its line${SEPARATOR}separator and the word quokka.`, -8_800),
  claude('user', 'Thanks.', -8_700)
]), 120_000);
write(path.join(project, `${OTHER}.jsonl`), jsonl([
  claude('user', 'Unrelated session about deployment windows.', -7_000),
  claude('assistant', 'Deployment windows are on Tuesdays.', -6_900)
]), 300_000);

const agentRecords = (id, answer, task = 'Check the ledger.') => [
  { type: 'fork-context-ref', agentId: id, parentSessionId: PARENT },
  claude('user', task, -8_850, { isSidechain: true, agentId: id, sessionId: PARENT }),
  claude('assistant', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'Math.round', path: 'billing/' } }], -8_840, { isSidechain: true, agentId: id }),
  claude('assistant', answer, -8_830, { isSidechain: true, agentId: id })
];
write(path.join(project, PARENT, 'subagents', `agent-${AGENT}.jsonl`), jsonl(agentRecords(AGENT, 'Found a wombat: invoice totals round half down.', 'Check rounding in invoices. Report every wombat you find.')), 100_000);
write(path.join(project, PARENT, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'Billing audit', spawnDepth: 1 }));
write(path.join(project, PARENT, 'subagents', 'workflows', 'wf_1234', `agent-${WORKFLOW_AGENT}.jsonl`), jsonl(agentRecords(WORKFLOW_AGENT, 'Workflow step verified the numbat ledger.')), 90_000);
write(path.join(project, PARENT, 'subagents', 'workflows', 'wf_1234', `agent-${WORKFLOW_AGENT}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
write(path.join(project, PARENT, 'subagents', 'workflows', 'wf_1234', 'journal.jsonl'), jsonl([{ type: 'user', message: { role: 'user', content: 'journal entry mentions a wombat' } }]));
// The same agent copied under a second parent: the newer copy stands for it.
write(path.join(project, PARENT, 'subagents', `agent-${COPIED_AGENT}.jsonl`), jsonl(agentRecords(COPIED_AGENT, 'Older copy of the echidna report.')), 500_000);
write(path.join(project, OTHER, 'subagents', `agent-${COPIED_AGENT}.jsonl`), jsonl(agentRecords(COPIED_AGENT, 'Newer copy of the echidna report.')), 80_000);

// --- Codex: plain, compressed, forked, damaged ---

const PLAIN = '019f0000-1111-7222-8333-aaaaaaaaaaaa';
const PACKED = '019f0000-2222-7222-8333-bbbbbbbbbbbb';
const FORK_PARENT = '019f0000-3333-7222-8333-cccccccccccc';
const FORK_CHILD = '019f0000-4444-7222-8333-dddddddddddd';
const DAMAGED = '019f0000-5555-7222-8333-eeeeeeeeeeee';

const codexLine = (type, payload, offset, ordinal = null) =>
  (ordinal === null ? { timestamp: iso(offset), type, payload } : { timestamp: iso(offset), ordinal, type, payload });
const bulk = 'x'.repeat(200_000);
const codexRollout = (id, cwd, marker, { ordinals = false } = {}) => {
  let n = 0;
  const line = (type, payload, offset) => codexLine(type, payload, offset, ordinals ? n++ : null);
  return [
    line('session_meta', { id, session_id: id, cwd, timestamp: iso(-5_000) }, -5_000),
    line('turn_context', { cwd, model: 'gpt-test' }, -4_900),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question about the ${marker}.` }] }, -4_800),
    // Records that never become messages, large enough to span read chunks.
    line('response_item', { type: 'function_call_output', call_id: 'c1', output: `${bulk} hidden-output-${marker}` }, -4_700),
    line('event_msg', { type: 'token_count', info: bulk }, -4_650),
    line('compacted', { message: `${bulk} hidden-compacted-${marker}` }, -4_600),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `grep ${marker}-command` }), call_id: 'c1' }, -4_500),
    // A payload whose keys come in another order still has to be read.
    { timestamp: iso(-4_400), type: 'response_item', payload: { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: `Answer about the ${marker}, ${'y'.repeat(150_000)} end-${marker}.` }] } }
  ];
};
const rolloutPath = (name, day = '01') => path.join(codexDir, 'sessions', '2026', '07', day, name);

write(rolloutPath(`rollout-2026-07-01T00-00-00-${PLAIN}.jsonl`), jsonl(codexRollout(PLAIN, '/work/plain', 'platypus', { ordinals: true })), 200_000);
write(rolloutPath(`rollout-2026-07-01T01-00-00-${FORK_PARENT}_${FORK_CHILD}.jsonl`), jsonl([
  codexLine('session_meta', { id: FORK_PARENT, session_id: FORK_PARENT, cwd: '/work/parent', timestamp: iso(-6_000) }, -6_000),
  codexLine('turn_context', { cwd: '/work/fork', model: 'gpt-test' }, -5_900),
  codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fork prompt about a bilby.' }] }, -5_800),
  ...Array.from({ length: 600 }, (_, i) => codexLine('event_msg', { type: 'token_count', info: i }, -5_700)),
  codexLine('turn_context', { cwd: '/work/later-directory', model: 'gpt-test' }, -5_000)
]), 210_000);

const zstdBuiltIn = typeof zlib.zstdCompressSync === 'function';
const zstdCommand = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
function compress(text) {
  if (zstdBuiltIn) return zlib.zstdCompressSync(Buffer.from(text));
  const result = spawnSync('zstd', ['-c'], { input: text, maxBuffer: 1 << 28, timeout: 30_000 });
  return result.stdout;
}
const canCompress = zstdBuiltIn || zstdCommand;
if (canCompress) {
  write(rolloutPath(`rollout-2026-07-02T00-00-00-${PACKED}.jsonl.zst`, '02'), compress(jsonl(codexRollout(PACKED, '/work/packed', 'kookaburra'))), 220_000);
  const damaged = compress(jsonl(codexRollout(DAMAGED, '/work/damaged', 'dingo')));
  write(rolloutPath(`rollout-2026-07-03T00-00-00-${DAMAGED}.jsonl.zst`, '03'), damaged.subarray(0, Math.floor(damaged.length / 2)), 230_000);
}

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
const baseEnv = {
  ...cleanEnv,
  NO_COLOR: '1',
  TZ: 'UTC',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: codexDir,
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
};
const cli = (args, env = baseEnv) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000, maxBuffer: 1 << 28 });
function ok(args, env = baseEnv) {
  const result = cli(args, env);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
const json = (args, env = baseEnv) => JSON.parse(ok([...args, '--json'], env));

console.log('\nClaude subagent transcripts');

test('listings leave subagents out unless asked', () => {
  const listed = json(['list', '--source', 'claude']);
  assert.deepEqual(listed.map(s => s.sessionId).sort(), [PARENT, OTHER].sort());
  const all = json(['list', '--source', 'claude', '--subagents']);
  assert.deepEqual(all.filter(s => s.subagent).map(s => s.sessionId).sort(), [AGENT, WORKFLOW_AGENT, COPIED_AGENT].sort());
  const agent = all.find(s => s.sessionId === AGENT);
  assert.equal(agent.parentSessionId, PARENT);
  assert.equal(agent.agentType, 'general-purpose');
  assert.equal(agent.title, 'Billing audit');
  assert.equal(agent.project, '/work/app');
  assert.match(ok(['list', '--subagents']), /a1111111 \[claude\] \/work\/app \(subagent of aaaaaaaa\)/);
  assert.equal(all.some(s => /journal/.test(s.filePath)), false, 'a workflow journal is not a transcript');
  for (const command of [['recap', '--days', '2'], ['activity', '--days', '2']]) {
    assert.equal(json(command).some(s => s.sessionId === AGENT), false, command[0]);
  }
  assert.equal(json(['projects']).find(p => p.path === '/work/app').sessionCount, 2);
});

test('search reads subagent transcripts and says whose they are', () => {
  const rows = json(['search', 'wombat', '--per-session', '5']);
  assert.deepEqual(rows.map(row => `${row.shortId}#${row.seq}`), ['a1111111#2', 'a1111111#0']);
  assert.equal(rows.every(row => row.subagent === true && row.parentSessionId === PARENT), true);
  // What a subagent was told came from its parent agent, not from the user.
  const prompt = rows.find(row => row.type === 'user');
  assert.equal(prompt.injected, true);
  const out = ok(['search', 'wombat']);
  assert.match(out, /^a1111111 \[claude\] \/work\/app \(subagent of aaaaaaaa\) claude .* #2 \(2 matches in session\)$/m);
  assert.match(out, /Drill in: add --session a1111111 /);
  assert.deepEqual(json(['search', 'numbat']).map(row => row.sessionId), [WORKFLOW_AGENT]);
  assert.equal(json(['search', 'wombat', '--source', 'codex']).length, 0);
  // An ordinary session carries no subagent fields.
  assert.equal('subagent' in json(['search', 'rounding errors'])[0], false);
});

test('show, --session and export open a subagent like any session', () => {
  const shown = ok(['show', 'a1111111']);
  assert.match(shown, /^Session: a1111111111111111\n/);
  assert.match(shown, /^Subagent of: aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa \(general-purpose: Billing audit\)$/m);
  assert.match(shown, /Parent agent/);
  assert.doesNotMatch(shown, /▶ You/);
  assert.match(shown, /Found a wombat/);
  assert.match(ok(['show', 'a2222222']), /^Subagent of: aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa \(workflow-subagent\)$/m);
  assert.doesNotMatch(ok(['show', 'aaaaaaaa']), /Subagent of|Parent agent/);
  const drilled = ok(['search', 'wombat', '--session', AGENT]);
  assert.match(drilled, /^2 matches in a1111111 \[claude\] \/work\/app$/m);
  assert.match(ok(['show', 'a1111111', '--around', '2', '-C', '1']), /Found a wombat/);
  assert.match(ok(['export', 'a1111111', '-f', 'text']), /Found a wombat: invoice totals round half down\./);
});

test('a copied subagent transcript counts once, as its newer copy', () => {
  const copies = json(['list', '--subagents']).filter(s => s.sessionId === COPIED_AGENT);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].parentSessionId, OTHER);
  assert.match(ok(['show', 'a3333333']), /Newer copy of the echidna report/);
  assert.deepEqual(json(['search', 'echidna']).map(row => row.matchesInSession), [1]);
});

console.log('\nJSONL reading');

test('a record holding a Unicode line separator is read whole', () => {
  const [row] = json(['search', 'quokka']);
  assert.equal(row.sessionId, PARENT);
  assert.equal(row.seq, 2);
  const messages = json(['show', 'aaaaaaaa']);
  assert.equal(messages.length, 4);
  assert.equal(messages[2].message.content[0].text.includes(SEPARATOR), true);
});

test('blank lines, CRLF endings and a missing final newline are fine', () => {
  const id = 'cccccccc-1111-4222-8333-cccccccccccc';
  const records = [claude('user', 'First odd line about a pademelon.', -3_000), claude('assistant', 'Second odd line.', -2_900), claude('user', 'Last line without a newline.', -2_800)];
  write(path.join(claudeDir, 'projects', '-work-odd', `${id}.jsonl`),
    `${JSON.stringify(records[0])}\r\n\r\n   \n${JSON.stringify(records[1])}\n{"broken": \n${JSON.stringify(records[2])}`, 50_000);
  const messages = json(['show', 'cccccccc']);
  assert.deepEqual(messages.map(m => m.message.content[0].text), ['First odd line about a pademelon.', 'Second odd line.', 'Last line without a newline.']);
  assert.equal(json(['search', 'without a newline'])[0].seq, 2);
});

console.log('\nCodex rollouts');

test('records that never become messages are skipped, the rest are intact', () => {
  const messages = json(['show', `codex:${PLAIN}`]);
  assert.deepEqual(messages.map(m => m.type), ['user', 'assistant', 'assistant']);
  assert.equal(messages[0].message.content[0].text, 'Question about the platypus.');
  assert.deepEqual(messages[1].message.content[0], { type: 'tool_use', name: 'exec_command', input: { cmd: 'grep platypus-command' } });
  assert.match(messages[2].message.content[0].text, /^Answer about the platypus, y+ end-platypus\.$/);
  assert.equal(json(['search', 'end-platypus'])[0].seq, 2);
  for (const hidden of ['hidden-output-platypus', 'hidden-compacted-platypus']) {
    assert.equal(json(['search', hidden, '--literal']).length, 0, hidden);
  }
  assert.equal(json(['search', 'platypus-command'])[0].matchMode, 'tools');
});

test('a forked rollout is its own session and is read from its head only', () => {
  const fork = json(['list', '--source', 'codex']).find(s => s.sessionId === FORK_CHILD);
  assert.ok(fork, 'the fork is listed under the id in its file name');
  // The parent record named another directory; the first turn says where the fork ran.
  assert.equal(fork.project, '/work/fork');
  assert.equal(json(['search', 'bilby'])[0].sessionId, FORK_CHILD);
});

if (canCompress) {
  test('a compressed rollout lists, shows and searches like a plain one', () => {
    const packed = json(['list', '--source', 'codex']).find(s => s.sessionId === PACKED);
    assert.ok(packed, 'compressed rollout is listed');
    assert.equal(packed.project, '/work/packed');
    assert.equal(packed.filePath.endsWith('.jsonl.zst'), true);
    const messages = json(['show', `codex:${PACKED}`]);
    assert.deepEqual(messages.map(m => m.type), ['user', 'assistant', 'assistant']);
    assert.match(messages[2].message.content[0].text, /end-kookaburra\.$/);
    assert.equal(json(['search', 'kookaburra'])[0].sessionId, PACKED);
    assert.match(ok(['export', `codex:${PACKED}`, '-f', 'text']), /Question about the kookaburra\./);
    assert.equal(json(['history', '--source', 'codex', '-n', '50']).some(entry => entry.display === 'Question about the kookaburra.'), true);
  });

  test('a damaged archive is read as far as it goes and stops nothing else', () => {
    const listing = cli(['list', '--source', 'codex', '--json']);
    assert.equal(listing.status, 0);
    assert.equal(JSON.parse(listing.stdout).some(s => s.sessionId === PLAIN), true);
    const search = cli(['search', 'platypus OR dingo OR kookaburra', '-n', '10', '--json']);
    assert.equal(search.status, 0);
    const rows = JSON.parse(search.stdout);
    assert.equal(rows.some(row => row.sessionId === PLAIN), true);
    assert.equal(rows.some(row => row.sessionId === PACKED), true);
    // The file is named once, however many times the command reads it.
    const warnings = search.stderr.split('\n').filter(line => line.startsWith('Could not read all of '));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`${DAMAGED}\\.jsonl\\.zst: `));
    const shown = cli(['show', `codex:${DAMAGED}`, '--json']);
    assert.equal(shown.status, 0);
  });

  test('without a way to decompress, compressed rollouts are skipped with one notice', () => {
    const result = cli(['list', '--source', 'codex', '--json'], { ...baseEnv, SESSIONS_ZSTD_READER: 'none' });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /^2 compressed Codex sessions skipped: reading \.jsonl\.zst needs Node 22\.15 or newer, or the zstd command\.\n$/);
    const ids = JSON.parse(result.stdout).map(s => s.sessionId);
    assert.equal(ids.includes(PACKED), false);
    assert.equal(ids.includes(PLAIN), true);
  });

  if (zstdCommand) {
    test('the zstd command reads them on a Node without built-in support', () => {
      const env = { ...baseEnv, SESSIONS_ZSTD_READER: 'command' };
      assert.equal(json(['search', 'kookaburra'], env)[0].sessionId, PACKED);
      assert.equal(json(['show', `codex:${PACKED}`], env).length, 3);
      assert.equal(json(['list', '--source', 'codex'], env).some(s => s.sessionId === PACKED), true);
    });
  } else {
    skip('the zstd command reads them on a Node without built-in support', 'zstd is not installed');
  }

  // Node 22 ends a cut-off archive without an error, so there the reader
  // follows the frames itself. This checks that on every Node.
  test('a file cut anywhere is told from a whole one, however it arrives', () => {
    const cutShort = (bytes, step) => {
      const frames = createFrameWatch();
      for (let at = 0; at < bytes.length; at += step) frames.write(bytes.subarray(at, at + step));
      return frames.cutShort();
    };
    const small = compress('a platypus\n'.repeat(40));
    const large = compress(Array.from({ length: 40_000 }, (_, i) => `line ${i} ${(i * 2654435761 % 4294967296).toString(36)}`).join('\n'));
    for (const whole of [small, large]) {
      for (const step of [1, 7, 1 << 16]) {
        assert.equal(cutShort(whole, step), false, `whole file of ${whole.length} bytes`);
        const cuts = whole.length < 400 ? [...whole.keys()] : [0, 1, 4, 5, 9, whole.length >> 2, whole.length >> 1, whole.length - 5, whole.length - 1];
        for (const cut of cuts) assert.equal(cutShort(whole.subarray(0, cut), step), true, `cut at ${cut} of ${whole.length}`);
      }
    }
    // Two frames in one file, then bytes after a frame that are not one.
    const two = Buffer.concat([small, small]);
    assert.equal(cutShort(two, 5), false);
    assert.equal(cutShort(two.subarray(0, two.length - 1), 5), true);
    assert.equal(cutShort(Buffer.concat([small, Buffer.from('not a frame')]), 5), false);
  });
} else {
  skip('compressed rollouts', 'this Node has no Zstandard support and zstd is not installed');
}

rmSync(root, { recursive: true, force: true });
const skipNote = skipped > 0 ? `, ${skipped} skipped` : '';
console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed${skipNote}\x1b[0m\n`);
process.exit(failed ? 1 : 0);
