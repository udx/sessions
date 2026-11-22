#!/usr/bin/env node

// Tests for the file-scan search backend: the engine on its own, then the CLI
// reading temporary transcripts. Nothing here needs Elasticsearch.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileQuery, fragmentsOf, searchFiles } from '../lib/local-search.js';
import { HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN } from '../lib/query.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'index.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${String(error.message).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

// --- the engine, against sessions held in memory ---

const plainMarks = text => text.replaceAll(HIGHLIGHT_OPEN, '[').replaceAll(HIGHLIGHT_CLOSE, ']');

function message(type, text, tools = []) {
  return {
    type,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: type,
      model: type === 'assistant' ? 'test-model' : undefined,
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...tools.map(tool => ({ type: 'tool_use', name: tool.name, input: tool.input }))
      ]
    }
  };
}

const memory = [
  {
    sessionId: 'one', shortId: 'one', source: 'claude', project: '/work/site',
    messages: [
      message('user', 'please set up the ghost inspector suite for the staging site'),
      message('assistant', 'Running it now.', [{ name: 'Bash', input: { command: 'curl https://api.ghostinspector.com/v1/suites/' } }]),
      message('assistant', 'The Inspector found a Ghost in the machine: two failures.'),
      message('user', 'ok deploy to production')
    ]
  },
  {
    sessionId: 'two', shortId: 'two', source: 'kimi', project: '/work/time',
    messages: [
      message('user', 'how do we log harvest time entries'),
      message('assistant', 'Harvest entries go through the API with a project id.'),
      message('assistant', '', [{ name: 'Bash', input: { command: 'harvest-cli log --hours 2 --note "fireflies sync"' } }]),
      message('user', 'fireflies transcript for the call please')
    ]
  },
  {
    sessionId: 'three', shortId: 'three', source: 'claude', project: '/work/misc',
    messages: [
      message('user', 'alpha is mentioned here'),
      message('assistant', 'and beta is mentioned separately'),
      message('assistant', 'gamma shows up with alpha in one place'),
      message('user', '<task-notification>alpha finished</task-notification>')
    ]
  }
];

const reader = {
  streamSessionMessages: async (session, callback) => {
    for (const entry of session.messages) if (callback(entry) === true) break;
  },
  extractTextContent: content => (Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : content || '')
};

const find = (query, options = {}) => searchFiles({ query, sessions: memory, reader, ...options });
const where = result => result.groups.flatMap(group => group.hits.map(hit => `${group.session.sessionId}#${hit.seq}`));

console.log('\nfile-scan engine');

await test('words match in any order, anywhere in one message', async () => {
  const adjacent = await find('ghost inspector');
  const reversed = await find('inspector ghost');
  assert.equal(adjacent.mode, 'smart');
  assert.deepEqual(where(adjacent), ['one#0']);
  assert.deepEqual(where(reversed), ['one#0']);
  assert.equal(adjacent.groups[0].matchesInSession, 2);
  assert.equal(reversed.totalMessages, 2);
  assert.equal(reversed.totalSessions, 1);
});

await test('the message containing the query word for word is the one shown', async () => {
  // Both #0 and #2 contain the two words; only #0 has them side by side.
  const result = await find('ghost inspector', { role: 'assistant' });
  assert.deepEqual(where(result), ['one#2']);
  const sessions = [{ ...memory[0], messages: [memory[0].messages[2], message('assistant', 'the ghost inspector suite is green')] }];
  const ranked = await searchFiles({ query: 'ghost inspector', sessions, reader });
  assert.deepEqual(where(ranked), ['one#1']);
});

await test('OR, NOT, quoted phrases and grep patterns', async () => {
  assert.deepEqual(where(await find('harvest OR fireflies', { perSession: 5 })), ['two#3', 'two#0', 'two#1']);
  assert.deepEqual(where(await find('ghost NOT machine')), ['one#0']);
  assert.deepEqual(where(await find('"ghost inspector"')), ['one#0']);
  assert.equal((await find('"inspector ghost"')).totalMessages, 0);
  assert.deepEqual(where(await find('staging\\|production', { perSession: 5 })), ['one#3', 'one#0']);
  assert.deepEqual(where(await find('inspector.*ghost')), ['one#2']);
  assert.equal((await find('ghost.*inspector.*machine')).totalMessages, 0);
});

await test('--literal matches the whole query as one substring and never loosens', async () => {
  const literal = await find('harvest OR fireflies', { literal: true });
  assert.equal(literal.mode, 'literal');
  assert.equal(literal.totalMessages, 0);
  assert.deepEqual(where(await find('Ghost in the machine', { literal: true })), ['one#2']);
  assert.equal((await find('ghostinspector.com', { literal: true })).totalMessages, 0);
  assert.equal(compileQuery('=>').literal, true);
});

await test('tool calls answer when no message text does', async () => {
  const result = await find('ghostinspector.com');
  assert.equal(result.mode, 'tools');
  assert.deepEqual(where(result), ['one#1']);
  const [hit] = result.groups[0].hits;
  assert.deepEqual(hit.tools, ['Bash']);
  assert.match(plainMarks(hit.toolFragments[0]), /api\.\[ghostinspector\.com\]\/v1/);
});

await test('--tools and --tool read tool calls from the start', async () => {
  const withTools = await find('harvest-cli', { includeTools: true });
  assert.equal(withTools.mode, 'smart');
  assert.deepEqual(where(withTools), ['two#2']);
  const byTool = await find('harvest', { tool: 'bash' });
  assert.deepEqual(where(byTool), ['two#2']);
  assert.equal((await find('harvest', { tool: 'Read' })).totalMessages, 0);
  // A word in the message and another in its tool call count together.
  assert.deepEqual(where(await find('running ghostinspector', { includeTools: true })), ['one#1']);
});

await test('terms spread across one session are found as a session', async () => {
  const result = await find('alpha beta');
  assert.equal(result.mode, 'session');
  assert.equal(result.totalSessions, 1);
  assert.equal(result.groups[0].session.sessionId, 'three');
});

await test('the closest matches come last, most terms first', async () => {
  const result = await find('alpha gamma delta');
  assert.equal(result.mode, 'partial');
  assert.deepEqual(where(result), ['three#2']);
  assert.equal(result.groups[0].hits[0].matched, 2);
  assert.equal((await find('delta epsilon zeta')).totalMessages, 0);
});

await test('--role, injected text and context', async () => {
  assert.deepEqual(where(await find('ghost', { role: 'user' })), ['one#0']);
  const injected = await find('alpha finished');
  assert.equal(injected.groups[0].hits[0].injected, true);
  const typed = await find('alpha', { perSession: 5 });
  // What the user typed leads; what a tool injected under the user role trails.
  assert.deepEqual(where(typed), ['three#0', 'three#2', 'three#3']);
  const context = await find('machine', { context: 1 });
  const [hit] = context.groups[0].hits;
  assert.deepEqual(hit.before.map(entry => entry.text), ['Running it now.']);
  assert.deepEqual(hit.after.map(entry => entry.text), ['ok deploy to production']);
  const edge = await find('staging site', { context: 2 });
  assert.equal(edge.groups[0].hits[0].before.length, 0);
  assert.equal(edge.groups[0].hits[0].after.length, 2);
});

await test('one session, in the order it was said', async () => {
  const result = await searchFiles({ query: 'harvest', sessions: [memory[1]], reader, inSession: true, limit: 10 });
  assert.deepEqual(where(result), ['two#0', 'two#1']);
  const capped = await searchFiles({ query: 'harvest', sessions: [memory[1]], reader, inSession: true, limit: 1 });
  assert.deepEqual(where(capped), ['two#0']);
  assert.equal(capped.totalMessages, 2);
});

await test('the scan stops once enough sessions matched, and says so', async () => {
  const stopped = await find('the', { limit: 1 });
  assert.equal(stopped.complete, false);
  assert.equal(stopped.scanned, 1);
  assert.equal(stopped.available, 3);
  const everything = await find('mentioned OR harvest OR ghost', { limit: 10 });
  assert.equal(everything.complete, true);
  assert.equal(everything.scanned, 3);
  assert.equal(everything.totalSessions, 3);
  // Filling the limit with the last session is still a complete scan.
  assert.equal((await find('mentioned OR harvest OR ghost', { limit: 3 })).complete, true);
  assert.equal((await find('mentioned OR harvest OR ghost', { limit: 2 })).complete, false);
});

await test('terms used together outrank a long text that merely contains them', async () => {
  const filler = 'lorem ipsum dolor sit amet '.repeat(30);
  const sessions = [{
    sessionId: 'rank', shortId: 'rank', source: 'claude', project: '/work/rank',
    messages: [
      message('assistant', `the invoice was sent. ${filler} later we talked about a refund`),
      message('assistant', 'issue the invoice refund today'),
      message('user', `<summary>invoice ${filler} refund</summary>`)
    ]
  }];
  const result = await searchFiles({ query: 'invoice refund', sessions, reader, perSession: 5 });
  assert.deepEqual(where(result), ['rank#1', 'rank#0', 'rank#2']);
  // Recency decides only when nothing else does.
  assert.deepEqual(where(await searchFiles({ query: 'invoice refund', sessions, reader, perSession: 5, sort: 'recent' })), ['rank#2', 'rank#1', 'rank#0']);
});

await test('--sort recent shows the latest match of each session', async () => {
  assert.deepEqual(where(await find('alpha')), ['three#0']);
  assert.deepEqual(where(await find('alpha', { sort: 'recent' })), ['three#3']);
});

await test('an unreadable session is skipped, not fatal', async () => {
  const flaky = {
    ...reader,
    streamSessionMessages: async (session, callback) => {
      if (session.sessionId === 'one') throw new Error('gone');
      return reader.streamSessionMessages(session, callback);
    }
  };
  const result = await searchFiles({ query: 'harvest', sessions: memory, reader: flaky });
  assert.equal(result.unreadable, 1);
  assert.deepEqual(where(result), ['two#0']);
});

await test('fragments cover the terms and mark every occurrence', () => {
  const far = `${'x '.repeat(200)}needle one here ${'y '.repeat(300)}second NEEDLE far away`;
  const [first, second] = fragmentsOf(far, ['needle']);
  assert.match(plainMarks(first), /^….*\[needle\] one here/);
  assert.match(plainMarks(second), /second \[NEEDLE\] far away$/);
  assert.equal(fragmentsOf('nothing here', ['needle']).length, 0);
  const both = fragmentsOf('alpha then a long way to beta', ['alpha', 'beta']);
  assert.deepEqual(both.map(plainMarks), ['[alpha] then a long way to [beta]']);
  assert.deepEqual(fragmentsOf('cost is $5.00 (net)', ['$5.00 (net)']).map(plainMarks), ['cost is [$5.00 (net)]']);
});

// --- the CLI, against transcripts on disk ---

const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-local-search-'));
const claudeDir = path.join(root, 'claude');
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();

function writeSession(project, id, records, ageMs) {
  const file = path.join(claudeDir, 'projects', project, `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const date = new Date(now - ageMs);
  utimesSync(file, date, date);
}

function claude(type, content, offset, cwd) {
  return {
    type,
    cwd,
    timestamp: iso(offset),
    message: {
      role: type,
      model: type === 'assistant' ? 'claude-test' : undefined,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content
    }
  };
}

const NEW_ID = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const MID_ID = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const OLD_ID = 'cccccccc-1111-4222-8333-cccccccccccc';

writeSession('-work-shop', NEW_ID, [
  claude('user', 'The checkout page throws a timeout on staging.', -9_000, '/work/shop'),
  claude('assistant', 'Looking at the checkout timeout now.', -8_900, '/work/shop'),
  claude('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'kubectl rollout restart deploy/checkout' } }], -8_800, '/work/shop'),
  claude('user', 'Did the restart help?', -8_700, '/work/shop'),
  claude('assistant', 'Yes. The staging checkout responds in 200ms.', -8_600, '/work/shop')
], 60_000);
writeSession('-work-shop', MID_ID, [
  claude('user', 'Write the release notes for the checkout rewrite.', -7_000, '/work/shop'),
  claude('assistant', 'Release notes drafted: checkout rewrite, faster carts.', -6_900, '/work/shop')
], 3_600_000);
writeSession('-work-blog', OLD_ID, [
  claude('user', 'Draft a post about our migration.', -5_000, '/work/blog'),
  claude('assistant', 'Here is a draft about the staging rehearsal.', -4_900, '/work/blog'),
  claude('assistant', 'And a section on the timeout we hit.', -4_800, '/work/blog')
], 86_400_000);

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
const env = {
  ...cleanEnv,
  NO_COLOR: '1',
  TZ: 'UTC',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: path.join(root, 'codex'),
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
};

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}
function ok(args) {
  const result = cli(args);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
const json = args => JSON.parse(ok([...args, '--json']));

console.log('\nsearch command without an index');

await test('one row per session, newest session first, with where to go next', () => {
  const lines = ok(['search', 'checkout']).trimEnd().split('\n');
  assert.equal(lines[0], '5 matches in 2 sessions');
  assert.match(lines[1], /^aaaaaaaa \[claude\] \/work\/shop you just now #0 \(3 matches in session\)$/);
  assert.match(lines[2], /The checkout page throws a timeout on staging\./);
  assert.match(lines[3], /^bbbbbbbb \[claude\] \/work\/shop you .* #0 \(2 matches in session\)$/);
  assert.equal(lines.at(-1), 'Drill in: add --session aaaaaaaa for every match in that session, or run: sessions show aaaaaaaa --around 0');
});

await test('a multi-word query is not a phrase', () => {
  const rows = json(['search', 'staging checkout']);
  // #0 and #4 both hold the two words; #4 has them side by side, so it leads.
  assert.deepEqual(rows.map(row => [row.shortId, row.seq, row.matchesInSession]), [['aaaaaaaa', 4, 2]]);
  assert.deepEqual(json(['search', 'checkout staging', '--per-session', '5']).map(row => row.seq), [0, 4]);
  assert.equal(rows[0].matchMode, 'smart');
  // The old behavior is one flag away.
  assert.deepEqual(json(['search', 'staging checkout', '--literal']).map(row => row.seq), [4]);
  assert.equal(json(['search', 'checkout staging', '--literal']).length, 0);
});

await test('operators work from the command line', () => {
  assert.deepEqual(json(['search', 'timeout OR migration', '-n', '5']).map(row => row.shortId), ['aaaaaaaa', 'cccccccc']);
  assert.deepEqual(json(['search', 'checkout NOT staging NOT timeout']).map(row => row.shortId), ['bbbbbbbb']);
  assert.deepEqual(json(['search', '"release notes"']).map(row => row.shortId), ['bbbbbbbb']);
  assert.deepEqual(json(['search', 'timeout\\|rewrite', '-n', '5']).map(row => row.shortId), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
});

await test('-n counts sessions and a stopped scan says what it skipped', () => {
  const out = ok(['search', 'checkout', '-n', '1']);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], 'Newest 1 matching session (read 1 of 3 sessions, newest first)');
  assert.equal(lines.at(-1), 'Older sessions were not read. Raise -n to go further back, or narrow with -p, --days or --since.');
  assert.equal(json(['search', 'checkout', '-n', '1']).length, 1);
});

await test('--per-session shows more of each session, capped by -n', () => {
  const rows = json(['search', 'checkout', '--per-session', '2']);
  assert.deepEqual(rows.map(row => `${row.shortId}#${row.seq}`), ['aaaaaaaa#0', 'aaaaaaaa#4', 'bbbbbbbb#0', 'bbbbbbbb#1']);
  assert.equal(json(['search', 'checkout', '--per-session', '2', '-n', '3']).length, 3);
});

await test('--session lists every match in order and show --around opens one', () => {
  const lines = ok(['search', 'checkout', '--session', 'aaaaaaaa']).trimEnd().split('\n');
  assert.equal(lines[0], '3 matches in aaaaaaaa [claude] /work/shop');
  assert.deepEqual(lines.filter(line => /^#\d+ /.test(line)).map(line => line.split(' ')[0]), ['#0', '#1', '#4']);
  assert.equal(lines.at(-1), 'Read around a match: sessions show aaaaaaaa --around 0');
  const around = ok(['show', 'aaaaaaaa', '--around', '4', '-C', '1']);
  assert.match(around, /Did the restart help\?/);
  assert.match(around, /responds in 200ms/);
  const none = ok(['search', 'migration', '--session', 'aaaaaaaa']);
  assert.equal(none, 'No matches for "migration" in aaaaaaaa.\n');
});

await test('tool calls: fallback, --tools and --tool', () => {
  const out = ok(['search', 'rollout restart']);
  assert.match(out, /^1 match in 1 session\nNo message text matches; showing tool calls \(commands, paths, arguments\) that do\.$/m);
  assert.match(out, /Bash: kubectl rollout restart deploy\/checkout/);
  const [row] = json(['search', 'rollout restart']);
  assert.equal(row.matchMode, 'tools');
  assert.equal(row.seq, 2);
  assert.equal(json(['search', 'kubectl', '--tools'])[0].matchMode, 'smart');
  assert.deepEqual(json(['search', 'checkout', '--tool', 'Bash']).map(row => row.seq), [2]);
});

await test('looser matches are labeled', () => {
  const spread = ok(['search', 'restart 200ms']);
  assert.match(spread, /No single message contains every term; showing sessions that contain them all\./);
  const closest = ok(['search', 'draft rehearsal nonexistentword']);
  assert.match(closest, /No message contains every term; showing the closest matches\./);
  assert.equal(json(['search', 'draft rehearsal nonexistentword'])[0].matchMode, 'partial');
  // Two of three terms never meet in one message here, so nothing is close.
  assert.equal(ok(['search', 'migration rehearsal nonexistentword']), 'No matches for "migration rehearsal nonexistentword".\n');
});

await test('filters, context and preview still apply', () => {
  assert.deepEqual(json(['search', 'timeout', '-p', 'blog']).map(row => row.shortId), ['cccccccc']);
  assert.deepEqual(json(['search', 'checkout', '--role', 'assistant']).map(row => [row.shortId, row.type]), [['aaaaaaaa', 'assistant'], ['bbbbbbbb', 'assistant']]);
  const tomorrow = new Date(now + 86_400_000).toISOString().slice(0, 10);
  assert.equal(json(['search', 'checkout', '--since', tomorrow]).length, 0);
  const [withContext] = json(['search', 'restart help', '-C', '1']);
  assert.deepEqual(withContext.contextMessages.map(entry => [entry.position, entry.type]), [['after', 'assistant']]);
  const wide = json(['search', 'restart help', '-C', '2'])[0].contextMessages;
  assert.deepEqual(wide.map(entry => entry.position), ['before', 'after']);
  const preview = ok(['search', 'release notes', '--preview']);
  assert.match(preview, /--- session prompts ---\n.*Write the release notes for the checkout rewrite\./);
});

await test('rows carry the same fields as indexed results', () => {
  const [row] = json(['search', 'checkout']);
  for (const key of ['sessionId', 'shortId', 'source', 'project', 'timestamp', 'type', 'snippets', 'contextMessages', 'matchesInSession', 'matchMode', 'seq', 'tools']) {
    assert.equal(key in row, true, key);
  }
  assert.equal(Object.keys(row).some(key => key.startsWith('_')), false);
  assert.equal(row.sessionId, NEW_ID);
});

await test('nothing found is one plain line', () => {
  assert.equal(ok(['search', 'zzzunseenword']), 'No matches for "zzzunseenword".\n');
  assert.deepEqual(json(['search', 'zzzunseenword']), []);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
