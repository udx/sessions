#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-dual-source-'));
const claudeDir = path.join(root, 'claude');
const codexDir = path.join(root, 'codex');
const kimiDir = path.join(root, 'kimi');
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
const md5 = value => createHash('md5').update(value).digest('hex');

const CLAUDE_ID = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const CLAUDE_ONLY_ID = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const CODEX_ID = '019f0000-1111-7222-8333-abcdefabcdef';
const CODEX_RESPONSE_ID = '019f0000-2222-7222-8333-bbbbbbbbbbbb';
const CODEX_ARCHIVE_ID = '019f0000-3333-7222-8333-cccccccccccc';
const PARENT_ID = '019f0000-9999-7222-8333-dddddddddddd';
const KIMI_ID = 'dddddddd-1111-4222-8333-dddddddddddd';
const KIMI_LEGACY_ID = 'eeeeeeee-1111-4222-8333-eeeeeeeeeeee';

function ensureDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonl(filePath, records, malformedTail = false) {
  ensureDir(filePath);
  const content = records.map(record => JSON.stringify(record)).join('\n') + (malformedTail ? '\n{"partial":' : '\n');
  writeFileSync(filePath, content);
  return filePath;
}

function touch(filePath, offset) {
  const date = new Date(now + offset);
  utimesSync(filePath, date, date);
}

function claudeMessage(type, text, offset, extra = {}) {
  return {
    type,
    cwd: extra.cwd || '/workspace/shared',
    timestamp: iso(offset),
    message: {
      role: type,
      model: type === 'assistant' ? (extra.model || 'claude-test') : undefined,
      content: extra.content || [{ type: 'text', text }]
    }
  };
}

function codexMeta(id, cwd, offset = -10_000) {
  return {
    type: 'session_meta',
    timestamp: iso(offset),
    payload: { id, session_id: id, cwd, timestamp: iso(offset), model_provider: 'openai' }
  };
}

function codexContext(cwd, offset = -9_000) {
  return { type: 'turn_context', timestamp: iso(offset), payload: { cwd, model: 'gpt-test' } };
}

function responseMessage(role, text, offset, content = null) {
  return {
    type: 'response_item',
    timestamp: iso(offset),
    payload: {
      type: 'message',
      role,
      content: content || [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
    }
  };
}

function eventMessage(role, text, offset) {
  return {
    type: 'event_msg',
    timestamp: iso(offset),
    payload: { type: role === 'assistant' ? 'agent_message' : 'user_message', message: text }
  };
}

function rolloutPath(id, name = 'active') {
  return path.join(codexDir, 'sessions', '2026', '07', '16', `rollout-2026-07-16T00-00-00-${name}-${id}.jsonl`);
}

const claudeMain = writeJsonl(
  path.join(claudeDir, 'projects', '-workspace-shared', `${CLAUDE_ID}.jsonl`),
  [
    claudeMessage('user', 'Claude alpha needle with literal [x].', -8_000),
    claudeMessage('assistant', 'Claude answer needle.', -7_900),
    claudeMessage('assistant', '', -7_800, {
      content: [{ type: 'tool_use', name: 'Read', input: { file: 'tool-only-claude' } }]
    }),
    claudeMessage('user', 'Claude second prompt.', -7_700),
    { type: 'summary', timestamp: iso(-7_600), summary: 'Claude compacted summary.' }
  ]
);
touch(claudeMain, -5_000);

const claudeOnly = writeJsonl(
  path.join(claudeDir, 'projects', '-workspace-claude-only', `${CLAUDE_ONLY_ID}.jsonl`),
  [
    claudeMessage('user', 'Claude-only project prompt.', -12_000, { cwd: '/workspace/claude-only' }),
    claudeMessage('assistant', 'Claude-only answer.', -11_900, { cwd: '/workspace/claude-only' })
  ]
);
touch(claudeOnly, -12_000);

writeJsonl(path.join(claudeDir, 'history.jsonl'), [
  { display: 'Claude history needle', timestamp: iso(-4_000), project: '/workspace/shared' }
]);

const codexMain = writeJsonl(rolloutPath(CODEX_ID), [
  codexMeta(CODEX_ID, '/workspace/shared'),
  codexContext('/workspace/shared'),
  responseMessage('developer', 'developer secret needle', -8_900),
  responseMessage('user', '<environment_context>internal environment needle</environment_context>', -8_850),
  responseMessage('user', '<turn_aborted>internal abort needle</turn_aborted>', -8_825),
  eventMessage('user', '<turn_aborted>internal event abort needle</turn_aborted>', -8_810),
  responseMessage('user', 'Codex unique needle with literal [x].', -8_800),
  eventMessage('user', 'Codex unique needle with literal [x].', -8_799),
  eventMessage('assistant', 'Codex answer needle.', -8_700),
  responseMessage('assistant', 'Codex answer needle.', -8_699),
  {
    type: 'response_item',
    timestamp: iso(-8_600),
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"tool secret needle"}', call_id: 'call-1' }
  },
  {
    type: 'response_item',
    timestamp: iso(-8_500),
    payload: { type: 'function_call_output', call_id: 'call-1', output: 'tool output secret needle' }
  },
  responseMessage('user', 'Response-only needle.', -8_400),
  eventMessage('assistant', 'Event-only needle.', -8_300),
  responseMessage('user', 'Repeat prompt.', -8_200),
  eventMessage('user', 'Repeat prompt.', -8_199),
  eventMessage('assistant', 'Spacer response.', -8_100),
  responseMessage('user', 'Repeat prompt.', -8_000),
  eventMessage('user', 'Repeat prompt.', -7_999),
  responseMessage('user', 'Image plus text needle.', -7_900, [
    { type: 'input_text', text: 'Image plus text needle.' },
    { type: 'input_image', image_url: 'data:image/png;base64,AA==' }
  ]),
  eventMessage('user', 'Image plus text needle.', -7_899),
  { type: 'response_item', timestamp: iso(-7_800), payload: { type: 'reasoning', encrypted_content: 'ignore-me' } }
], true);
touch(codexMain, -1_000);

const responseOnly = writeJsonl(rolloutPath(CODEX_RESPONSE_ID, 'child'), [
  codexMeta(PARENT_ID, '/wrong-parent', -15_000),
  codexMeta(CODEX_RESPONSE_ID, '/workspace/codex-only', -14_900),
  codexContext('/workspace/codex-only', -14_800),
  responseMessage('user', 'Legacy response-only prompt.', -14_700),
  responseMessage('assistant', 'Legacy response-only answer.', -14_600)
]);
touch(responseOnly, -2_000);

const archive = writeJsonl(
  path.join(codexDir, 'archived_sessions', `rollout-2026-07-15T00-00-00-${CODEX_ARCHIVE_ID}.jsonl`),
  [
    codexMeta(CODEX_ARCHIVE_ID, '/workspace/archive', -20_000),
    codexContext('/workspace/archive', -19_900),
    eventMessage('user', 'Archived Codex needle.', -19_800),
    eventMessage('assistant', 'Archived answer.', -19_700)
  ]
);
touch(archive, -3_000);

const olderDuplicate = writeJsonl(
  path.join(codexDir, 'archived_sessions', `rollout-2026-07-14T00-00-00-${CODEX_RESPONSE_ID}.jsonl`),
  [
    codexMeta(CODEX_RESPONSE_ID, '/wrong-duplicate', -30_000),
    eventMessage('user', 'Older duplicate must not win.', -29_000)
  ]
);
touch(olderDuplicate, 500);

const collision = writeJsonl(rolloutPath(CLAUDE_ID, 'collision'), [
  codexMeta(CLAUDE_ID, '/workspace/collision', -25_000),
  codexContext('/workspace/collision', -24_900),
  eventMessage('user', 'Cross-source collision prompt.', -24_800)
]);
touch(collision, -4_000);

writeFileSync(path.join(codexDir, 'sessions', 'ignored.jsonl.tmp'), '{"ignored":true}\n');
writeJsonl(path.join(codexDir, 'history.jsonl'), [
  { session_id: CODEX_ID, text: 'Codex history needle', ts: Math.floor((now - 2_000) / 1000) },
  { session_id: CODEX_RESPONSE_ID, text: 'Legacy history needle', ts: Math.floor((now - 6_000) / 1000) }
]);

// --- Kimi fixtures ---
// Modern layout: sessions/wd_<slug>_<hash>/session_<uuid>/{state.json,agents/main/wire.jsonl}
// Legacy layout: sessions/<md5(workdir)>/<uuid>/context.jsonl with project
// resolution through kimi.json work_dirs, falling back to the system prompt.

function kimiWireAppend(text, offset, kind = 'user') {
  return {
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind } },
    time: now + offset
  };
}

function kimiLoop(event, offset) {
  return { type: 'context.append_loop_event', event, time: now + offset };
}

const kimiModernDir = path.join(kimiDir, 'sessions', 'wd_shared_aabbccddeeff', `session_${KIMI_ID}`);
ensureDir(path.join(kimiModernDir, 'state.json'));
writeFileSync(
  path.join(kimiModernDir, 'state.json'),
  JSON.stringify({
    createdAt: iso(-9_000),
    updatedAt: iso(-1_000),
    title: 'Kimi unique needle',
    workDir: '/workspace/shared',
    agents: { main: { homedir: path.join(kimiModernDir, 'agents', 'main'), type: 'main' } }
  }) + '\n'
);
const kimiMain = writeJsonl(path.join(kimiModernDir, 'agents', 'main', 'wire.jsonl'), [
  { type: 'metadata', protocol_version: '1.4', created_at: now - 9_000 },
  { type: 'llm.request', kind: 'loop', provider: 'kimi', model: 'kimi-test', time: now - 8_900 },
  kimiWireAppend('<system-reminder>injected internal needle</system-reminder>', -8_850, 'injection'),
  kimiWireAppend('Kimi unique needle with literal [x].', -8_800),
  kimiLoop({ type: 'step.begin', turnId: '0', step: 1 }, -8_700),
  kimiLoop({ type: 'content.part', part: { type: 'think', think: 'kimi thinking secret needle' } }, -8_690),
  kimiLoop({ type: 'content.part', part: { type: 'text', text: 'Kimi answer needle.' } }, -8_680),
  kimiLoop({ type: 'tool.call', name: 'Shell', args: { command: 'kimi tool secret needle' } }, -8_670),
  kimiLoop({ type: 'tool.result', result: { output: 'kimi tool output secret needle' } }, -8_660),
  kimiLoop({ type: 'step.end', finishReason: 'tool_use' }, -8_650),
  kimiWireAppend('Kimi second prompt.', -8_600),
  kimiLoop({ type: 'step.begin', turnId: '1', step: 1 }, -8_500),
  kimiLoop({ type: 'content.part', part: { type: 'text', text: 'Second kimi answer.' } }, -8_490),
  kimiLoop({ type: 'step.end', finishReason: 'stop' }, -8_480)
]);
touch(kimiMain, -1_000);

ensureDir(path.join(kimiDir, 'kimi.json'));
writeFileSync(
  path.join(kimiDir, 'kimi.json'),
  JSON.stringify({ work_dirs: [{ path: '/workspace/kimi-legacy', kaos: 'local', last_session_id: null }] }) + '\n'
);

const kimiLegacy = writeJsonl(
  path.join(kimiDir, 'sessions', md5('/workspace/kimi-legacy'), KIMI_LEGACY_ID, 'context.jsonl'),
  [
    { role: '_system_prompt', content: 'You are Kimi Code CLI. The current working directory is `/workspace/kimi-legacy`. system prompt secret needle' },
    { role: '_checkpoint', id: 0 },
    { role: 'user', content: 'Kimi legacy needle prompt.' },
    {
      role: 'assistant',
      content: [
        { type: 'think', think: 'legacy thinking secret needle' },
        { type: 'text', text: 'Kimi legacy answer.' }
      ],
      tool_calls: [{ type: 'function', id: 'tool_1', function: { name: 'Read', arguments: '{"file":"legacy tool secret needle"}' } }]
    },
    { role: 'tool', content: [{ type: 'text', text: 'legacy tool output secret needle' }], tool_call_id: 'tool_1' },
    { role: '_usage', token_count: 10 },
    { role: 'user', content: 'Legacy second prompt.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Legacy second answer.' }] }
  ]
);
touch(kimiLegacy, -2_000);

const kimiCollision = writeJsonl(
  path.join(kimiDir, 'sessions', md5('/workspace/collision'), CLAUDE_ID, 'context.jsonl'),
  [
    { role: '_system_prompt', content: 'You are Kimi Code CLI. The current working directory is `/workspace/collision`.' },
    { role: 'user', content: 'Kimi collision prompt.' }
  ]
);
touch(kimiCollision, -4_000);

writeJsonl(path.join(kimiDir, 'user-history', `${md5('/workspace/shared')}.jsonl`), [
  { content: 'Kimi history needle' },
  { content: '/model' }
]);

const baseEnv = {
  ...process.env,
  NO_COLOR: '1',
  TZ: 'UTC',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: codexDir,
  SESSIONS_KIMI_DIR: kimiDir
};

function invoke(args, env = baseEnv) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}

function run(args, env = baseEnv) {
  const result = invoke(args, env);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

function json(args, env = baseEnv) {
  return JSON.parse(run([...args, '--json'], env));
}

function fails(args, pattern) {
  const result = invoke(args);
  assert.notEqual(result.status, 0, `command unexpectedly succeeded: ${args.join(' ')}`);
  assert.match(result.stderr, pattern);
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (error) {
    failed++;
    console.log(`  \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`    ${error.message}`);
  }
}

console.log('\ndual-source fixtures');

test('help advertises Claude, Codex, and Kimi', () => {
  assert.match(run(['--help']), /Claude Code, Codex, and Kimi/);
  assert.match(run(['list', '--help']), /--source/);
});

test('default list includes all sources', () => {
  const data = json(['list', '--limit', '20']);
  assert.deepEqual(new Set(data.map(item => item.source)), new Set(['claude', 'codex', 'kimi']));
});

test('source filters isolate Claude, Codex, and Kimi', () => {
  assert(json(['list', '--source', 'claude', '--limit', '20']).every(item => item.source === 'claude'));
  assert(json(['list', '--source', 'codex', '--limit', '20']).every(item => item.source === 'codex'));
  assert(json(['list', '--source', 'kimi', '--limit', '20']).every(item => item.source === 'kimi'));
});

test('list is globally sorted and respects limit', () => {
  const data = json(['list', '--limit', '2']);
  assert.equal(data.length, 2);
  assert(data[0].modifiedAt >= data[1].modifiedAt);
});

test('Codex list extracts model and real first prompt', () => {
  const item = json(['list', '--source', 'codex', '--project', '/workspace/shared', '--limit', '5'])
    .find(session => session.sessionId === CODEX_ID);
  assert.equal(item.model, 'gpt-test');
  assert.equal(item.firstPrompt, 'Codex unique needle with literal [x].');
  assert(!item.firstPrompt.includes('environment_context'));
});

test('Codex full counts deduplicate paired messages', () => {
  const item = json(['list', '--source', 'codex', '--project', '/workspace/shared', '--full', '--limit', '5'])
    .find(session => session.sessionId === CODEX_ID);
  assert.equal(item.userCount, 5);
  assert.equal(item.assistantCount, 4);
  assert.equal(item.messageCount, 9);
});

test('project filter is case-insensitive for Codex', () => {
  const data = json(['list', '--source', 'codex', '--project', '/WORKSPACE/CODEX-ONLY', '--limit', '10']);
  assert.equal(data.length, 1);
  assert.equal(data[0].sessionId, CODEX_RESPONSE_ID);
});

test('canonical child metadata beats copied parent metadata', () => {
  const item = json(['list', '--source', 'codex', '--limit', '20']).find(session => session.sessionId === CODEX_RESPONSE_ID);
  assert.equal(item.project, '/workspace/codex-only');
});

test('active and archived Codex sessions are discovered', () => {
  const ids = new Set(json(['list', '--source', 'codex', '--limit', '20']).map(item => item.sessionId));
  assert(ids.has(CODEX_ID));
  assert(ids.has(CODEX_ARCHIVE_ID));
});

test('active session wins over newer archived duplicate', () => {
  const matches = json(['list', '--source', 'codex', '--limit', '20']).filter(item => item.sessionId === CODEX_RESPONSE_ID);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].project, '/workspace/codex-only');
});

test('projects merges a shared path across sources', () => {
  const project = json(['projects']).find(item => item.path === '/workspace/shared');
  assert.equal(project.source, 'all');
  assert.equal(project.sources.claude, 1);
  assert.equal(project.sources.codex, 1);
  assert.equal(project.sources.kimi, 1);
});

test('projects source filter reports only that source', () => {
  const data = json(['projects', '--source', 'codex']);
  assert(data.every(project => project.source === 'codex'));
  assert(data.some(project => project.path === '/workspace/archive'));
});

test('show resolves a Codex short prefix', () => {
  const shortId = json(['list', '--source', 'codex', '--project', '/workspace/shared', '--limit', '5'])
    .find(item => item.sessionId === CODEX_ID).shortId;
  const messages = json(['show', shortId, '--source', 'codex']);
  assert(messages.length > 0);
  assert(messages.every(message => message.source === 'codex'));
});

test('show removes internal, developer, reasoning, and tool outputs', () => {
  const text = JSON.stringify(json(['show', CODEX_ID, '--source', 'codex']));
  assert(!text.includes('environment needle'));
  assert(!text.includes('abort needle'));
  assert(!text.includes('developer secret'));
  assert(!text.includes('tool output secret'));
  assert(!text.includes('encrypted_content'));
});

test('show retains response-only and event-only messages', () => {
  const text = JSON.stringify(json(['show', CODEX_ID, '--source', 'codex']));
  assert(text.includes('Response-only needle.'));
  assert(text.includes('Event-only needle.'));
});

test('show collapses adjacent duplicates but retains later repeats', () => {
  const messages = json(['show', CODEX_ID, '--source', 'codex']);
  const texts = messages.flatMap(message => message.message?.content || []).map(block => block.text).filter(Boolean);
  assert.equal(texts.filter(text => text === 'Codex unique needle with literal [x].').length, 1);
  assert.equal(texts.filter(text => text === 'Repeat prompt.').length, 2);
});

test('show human output labels Codex and displays tools', () => {
  const out = run(['show', CODEX_ID, '--source', 'codex']);
  assert.match(out, /Source: codex/);
  assert.match(out, /Codex/);
  assert.match(out, /exec_command/);
});

test('show --no-tools removes tool calls', () => {
  const out = run(['show', CODEX_ID, '--source', 'codex', '--no-tools']);
  assert(!out.includes('exec_command'));
  assert(out.includes('Codex answer needle.'));
});

test('show --assistant-only contains only text assistants', () => {
  const messages = json(['show', CODEX_ID, '--source', 'codex', '--assistant-only']);
  assert(messages.every(message => message.type === 'assistant'));
  assert(messages.every(message => message.message.content.some(block => block.type === 'text')));
});

test('show offset and limit apply after role filtering', () => {
  const messages = json(['show', CODEX_ID, '--source', 'codex', '--user-only', '--offset', '1', '--limit', '2']);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].message.content[0].text, 'Response-only needle.');
});

test('search finds a Codex paired message exactly once', () => {
  const data = json(['search', 'Codex unique needle', '--source', 'codex', '--limit', '20']);
  assert.equal(data.filter(item => item.sessionId === CODEX_ID).length, 1);
});

test('search supports literal regex punctuation', () => {
  const data = json(['search', '[x]', '--limit', '20']);
  assert.deepEqual(new Set(data.map(item => item.source)), new Set(['claude', 'codex', 'kimi']));
});

test('search finds response-only and event-only messages', () => {
  assert.equal(json(['search', 'Response-only needle', '--source', 'codex']).length, 1);
  assert.equal(json(['search', 'Event-only needle', '--source', 'codex']).length, 1);
});

test('search excludes internal, developer, reasoning, and tool output text', () => {
  for (const query of ['environment needle', 'abort needle', 'developer secret', 'tool output secret', 'ignore-me']) {
    assert.equal(json(['search', query, '--source', 'codex']).length, 0, query);
  }
});

test('search context is normalized', () => {
  const [match] = json(['search', 'Response-only needle', '--source', 'codex', '-C', '1']);
  assert(Array.isArray(match.contextMessages));
  assert(match.contextMessages.length > 0);
});

test('search project filter and future date return no false positives', () => {
  assert.equal(json(['search', 'needle', '--source', 'codex', '--project', '/missing']).length, 0);
  const future = new Date(now + 86_400_000).toISOString().slice(0, 10);
  assert.equal(json(['search', 'needle', '--source', 'codex', '--since', future]).length, 0);
});

test('Codex text export uses CODEX labels', () => {
  const out = run(['export', CODEX_ID, '--source', 'codex', '--format', 'text']);
  assert.match(out, /\[CODEX/);
  assert(!out.includes('[CLAUDE'));
});

test('Codex markdown export identifies its source', () => {
  const out = run(['export', CODEX_ID, '--source', 'codex', '--format', 'md']);
  assert.match(out, /\*\*Source:\*\* codex/);
  assert.match(out, /\*\*Codex\*\*/);
});

test('Codex JSON export is normalized and deduplicated', () => {
  const messages = JSON.parse(run(['export', CODEX_ID, '--source', 'codex', '--format', 'json']));
  const text = JSON.stringify(messages);
  assert.equal((text.match(/Codex unique needle/g) || []).length, 1);
  assert(messages.every(message => message.source === 'codex'));
});

test('export writes to a requested file', () => {
  const output = path.join(root, 'export.md');
  run(['export', CODEX_RESPONSE_ID, '--source', 'codex', '--output', output]);
  assert.match(readFileSync(output, 'utf8'), /Legacy response-only prompt/);
});

test('Codex history converts epoch seconds and joins project metadata', () => {
  const [entry] = json(['history', '--source', 'codex', '--limit', '1']);
  assert.equal(entry.source, 'codex');
  assert.equal(entry.projectPath, '/workspace/shared');
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('history supports source, project, and text filtering', () => {
  const data = json(['history', '--source', 'codex', '--project', '/workspace/codex-only', '--search', 'Legacy']);
  assert.equal(data.length, 1);
  assert.equal(data[0].sessionId, CODEX_RESPONSE_ID);
});

test('mixed history is globally sorted', () => {
  const data = json(['history', '--limit', '10']);
  assert.deepEqual(new Set(data.map(entry => entry.source)), new Set(['claude', 'codex', 'kimi']));
  // Kimi user-history carries no timestamps; those entries sort last as 0.
  const times = data.map(entry => (entry.timestamp ? new Date(entry.timestamp).getTime() : 0));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('recap returns Codex prompts, counts, and source', () => {
  const recap = json(['recap', '--source', 'codex', '--project', '/workspace/shared', '--days', '30', '--limit', '5'])
    .find(item => item.sessionId === CODEX_ID);
  assert.equal(recap.source, 'codex');
  assert.equal(recap.userCount, 5);
  assert.equal(recap.prompts[0].text, 'Codex unique needle with literal [x].');
});

test('activity returns all sources and supports project filtering', () => {
  const data = json(['activity', '--project', '/workspace/shared', '--days', '30', '--limit', '10']);
  assert.deepEqual(new Set(data.map(item => item.source)), new Set(['claude', 'codex', 'kimi']));
  assert(data.every(item => item.project === '/workspace/shared'));
});

test('qualified IDs resolve a cross-source full-ID collision', () => {
  const messages = json(['show', `claude:${CLAUDE_ID}`]);
  assert(messages.every(message => message.source === 'claude'));
  const codexMessages = json(['show', `codex:${CLAUDE_ID}`]);
  assert(codexMessages.every(message => message.source === 'codex'));
  const kimiMessages = json(['show', `kimi:${CLAUDE_ID}`]);
  assert(kimiMessages.every(message => message.source === 'kimi'));
});

test('unqualified cross-source collision errors instead of guessing', () => {
  fails(['show', CLAUDE_ID], /Ambiguous session ID/);
});

test('invalid source, ID, format, and role combination fail clearly', () => {
  fails(['list', '--source', 'other'], /source must be one of/);
  fails(['show', 'missing-id'], /Session not found/);
  fails(['export', CODEX_ID, '--source', 'codex', '--format', 'xml'], /Unsupported format/);
  fails(['show', CODEX_ID, '--source', 'codex', '--user-only', '--assistant-only'], /cannot be used together/);
});

test('all JSON commands return arrays against empty roots', () => {
  const emptyRoot = path.join(root, 'empty');
  const emptyEnv = {
    ...baseEnv,
    SESSIONS_CLAUDE_DIR: path.join(emptyRoot, 'claude'),
    SESSIONS_CODEX_DIR: path.join(emptyRoot, 'codex'),
    SESSIONS_KIMI_DIR: path.join(emptyRoot, 'kimi')
  };
  for (const args of [
    ['list'], ['projects'], ['search', 'needle'], ['history'], ['recap'], ['activity']
  ]) {
    assert.deepEqual(json(args, emptyEnv), [], args[0]);
  }
});

test('malformed trailing JSONL and ignored temp files do not break discovery', () => {
  const data = json(['list', '--source', 'codex', '--limit', '50']);
  assert(data.some(item => item.sessionId === CODEX_ID));
  assert(!data.some(item => item.filePath.endsWith('.tmp')));
});

console.log('\nkimi source');

test('list discovers modern and legacy Kimi sessions with their projects', () => {
  const data = json(['list', '--source', 'kimi', '--limit', '20']);
  const modern = data.find(item => item.sessionId === KIMI_ID);
  const legacy = data.find(item => item.sessionId === KIMI_LEGACY_ID);
  assert(modern, 'modern session discovered');
  assert(legacy, 'legacy session discovered');
  assert.equal(modern.project, '/workspace/shared');
  assert.equal(modern.format, 'wire');
  assert.equal(legacy.project, '/workspace/kimi-legacy');
  assert.equal(legacy.format, 'context');
});

test('modern Kimi list extracts model and real first prompt', () => {
  const item = json(['list', '--source', 'kimi', '--project', '/workspace/shared', '--limit', '5'])
    .find(session => session.sessionId === KIMI_ID);
  assert.equal(item.model, 'kimi-test');
  assert.equal(item.firstPrompt, 'Kimi unique needle with literal [x].');
  assert(!item.firstPrompt.includes('system-reminder'));
});

test('Kimi full counts group streamed loop events into one message per step', () => {
  const item = json(['list', '--source', 'kimi', '--project', '/workspace/shared', '--full', '--limit', '5'])
    .find(session => session.sessionId === KIMI_ID);
  assert.equal(item.userCount, 2);
  assert.equal(item.assistantCount, 2);
  assert.equal(item.messageCount, 4);
});

test('Kimi project filter matches modern bucket names', () => {
  const data = json(['list', '--source', 'kimi', '--project', 'wd_shared', '--limit', '10']);
  assert.equal(data.length, 1);
  assert.equal(data[0].sessionId, KIMI_ID);
});

test('Kimi projects reports modern and legacy project paths', () => {
  const data = json(['projects', '--source', 'kimi']);
  assert(data.every(project => project.source === 'kimi'));
  const paths = data.map(project => project.path);
  assert(paths.includes('/workspace/shared'));
  assert(paths.includes('/workspace/kimi-legacy'));
});

test('modern Kimi show skips injections and tool results but renders tool calls', () => {
  const out = run(['show', KIMI_ID, '--source', 'kimi']);
  assert.match(out, /Source: kimi/);
  assert.match(out, /Kimi/);
  assert.match(out, /Shell/);
  assert(out.includes('Kimi answer needle.'));
  assert(!out.includes('injected internal needle'));
  assert(!out.includes('kimi tool output secret needle'));
});

test('modern Kimi show --no-tools hides tool calls but keeps text', () => {
  const out = run(['show', KIMI_ID, '--source', 'kimi', '--no-tools']);
  assert(!out.includes('Shell'));
  assert(out.includes('Kimi answer needle.'));
});

test('modern Kimi show --assistant-only contains only text assistants', () => {
  const messages = json(['show', KIMI_ID, '--source', 'kimi', '--assistant-only']);
  assert(messages.length > 0);
  assert(messages.every(message => message.type === 'assistant'));
  assert(messages.every(message => message.message.content.some(block => block.type === 'text')));
});

test('modern Kimi search finds text but not injections, thinking, or tool internals', () => {
  assert.equal(json(['search', 'Kimi answer needle', '--source', 'kimi']).length, 1);
  for (const query of ['injected internal needle', 'kimi thinking secret', 'kimi tool output secret', 'kimi tool secret']) {
    assert.equal(json(['search', query, '--source', 'kimi']).length, 0, query);
  }
  const shown = JSON.stringify(json(['show', KIMI_ID, '--source', 'kimi']));
  assert(!shown.includes('kimi thinking secret needle'), 'thinking stays out of --json output');
});

test('modern Kimi messages carry timestamps from the wire log', () => {
  const [match] = json(['search', 'Kimi second prompt', '--source', 'kimi']);
  assert(match.timestamp, 'has timestamp');
  assert(!Number.isNaN(new Date(match.timestamp).getTime()), 'timestamp parses');
});

test('legacy Kimi session parses context records and skips internal roles', () => {
  const item = json(['list', '--source', 'kimi', '--project', '/workspace/kimi-legacy', '--full', '--limit', '5'])
    .find(session => session.sessionId === KIMI_LEGACY_ID);
  assert.equal(item.firstPrompt, 'Kimi legacy needle prompt.');
  assert.equal(item.userCount, 2);
  assert.equal(item.assistantCount, 2);

  const out = run(['show', KIMI_LEGACY_ID, '--source', 'kimi']);
  assert(out.includes('Kimi legacy answer.'));
  assert.match(out, /Read/);
  assert(!out.includes('legacy tool output secret needle'));
  assert(!out.includes('system prompt secret needle'));

  assert.equal(json(['search', 'legacy thinking secret', '--source', 'kimi']).length, 0);
  assert.equal(json(['search', 'legacy tool secret', '--source', 'kimi']).length, 0);
  assert.equal(json(['search', 'Kimi legacy answer', '--source', 'kimi']).length, 1);
  const shown = JSON.stringify(json(['show', KIMI_LEGACY_ID, '--source', 'kimi']));
  assert(!shown.includes('legacy thinking secret needle'), 'thinking stays out of --json output');
});

test('legacy Kimi project falls back to the system prompt when unmapped', () => {
  const item = json(['list', '--source', 'kimi', '--limit', '20'])
    .find(session => session.sessionId === CLAUDE_ID);
  assert.equal(item.project, '/workspace/collision');
});

test('Kimi exports label their source', () => {
  const md = run(['export', KIMI_ID, '--source', 'kimi', '--format', 'md']);
  assert.match(md, /\*\*Source:\*\* kimi/);
  assert.match(md, /\*\*Kimi\*\*/);
  const text = run(['export', KIMI_ID, '--source', 'kimi', '--format', 'text']);
  assert.match(text, /\[KIMI/);
  assert(!text.includes('[CLAUDE'));
});

test('Kimi history resolves project paths from session workDirs', () => {
  const data = json(['history', '--source', 'kimi', '--search', 'Kimi history needle']);
  assert.equal(data.length, 1);
  assert.equal(data[0].source, 'kimi');
  assert.equal(data[0].projectPath, '/workspace/shared');
  assert.equal(data[0].display, 'Kimi history needle');
});

test('recap returns Kimi prompts, counts, and source', () => {
  const recap = json(['recap', '--source', 'kimi', '--project', '/workspace/shared', '--days', '30', '--limit', '5'])
    .find(item => item.sessionId === KIMI_ID);
  assert.equal(recap.source, 'kimi');
  assert.equal(recap.userCount, 2);
  assert.equal(recap.prompts[0].text, 'Kimi unique needle with literal [x].');
});

rmSync(root, { recursive: true, force: true });
const color = failed ? 31 : 32;
console.log(`\n\x1b[${color}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
