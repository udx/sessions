#!/usr/bin/env node

import assert from 'assert';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = `node ${path.join(__dirname, 'index.js')}`;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

function run(cmd, timeout = 30000) {
  return execSync(`${CLI} ${cmd}`, { encoding: 'utf8', timeout, env: { ...process.env, NO_COLOR: '1' } });
}

console.log('\nprojects command');
test('returns valid JSON', () => {
  const out = run('projects --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  assert(data.length > 0, 'should have projects');
});

test('shows project paths and session counts', () => {
  const out = run('projects --json');
  const data = JSON.parse(out);
  for (const p of data) {
    assert(p.path, 'project should have path');
    assert(typeof p.sessionCount === 'number', 'should have sessionCount');
    assert(typeof p.totalSize === 'number', 'should have totalSize');
  }
});

test('human-readable output works', () => {
  const out = run('projects');
  assert(out.includes('projects'), 'should mention projects');
});

console.log('\nlist command');
test('lists sessions as JSON', () => {
  const out = run('list --limit 3 --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  assert(data.length > 0, 'should have sessions');
  assert(data.length <= 3, 'should respect limit');
});

test('sessions have required fields', () => {
  const out = run('list --limit 1 --json');
  const data = JSON.parse(out);
  const s = data[0];
  assert(s.sessionId, 'should have sessionId');
  assert(s.shortId, 'should have shortId');
  assert(s.project, 'should have project');
  assert(s.filePath, 'should have filePath');
  assert(s.firstPrompt !== undefined, 'should have firstPrompt');
});

test('human-readable list works', () => {
  const out = run('list --limit 3');
  assert(out.includes('sessions'), 'should mention sessions');
});

test('--project filter works', () => {
  const out = run('list --limit 50 --json');
  const all = JSON.parse(out);
  if (all.length > 1) {
    const project = all[0].project;
    const filtered = run(`list --project "${project}" --limit 50 --json`);
    const filteredData = JSON.parse(filtered);
    assert(filteredData.every(s => s.project.includes(project)), 'all should match filter');
    assert(filteredData.length <= all.length, 'filtered should be <= total');
  }
});

test('--full flag provides message counts', () => {
  const out = run('list --limit 1 --full --json');
  const data = JSON.parse(out);
  assert(data[0].messageCount !== undefined, 'should have messageCount with --full');
});

console.log('\nshow command');
test('shows session by short ID', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --limit 3 --json`);
  const messages = JSON.parse(out);
  assert(Array.isArray(messages), 'should be array');
  assert(messages.length > 0, 'should have messages');
});

test('--user-only filter works', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --user-only --limit 5 --json`);
  const messages = JSON.parse(out);
  assert(messages.every(m => m.type === 'user'), 'all should be user messages');
});

test('--assistant-only filter works', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --assistant-only --limit 5 --json`);
  const messages = JSON.parse(out);
  assert(messages.every(m => m.type === 'assistant'), 'all should be assistant messages');
});

test('human-readable show works', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --limit 3`);
  assert(out.includes('Session:'), 'should show session header');
});

test('invalid session ID errors', () => {
  try {
    run('show nonexistent-id-12345');
    assert.fail('should have thrown');
  } catch (e) {
    assert(e.status !== 0 || e.stderr?.includes('not found'), 'should error on invalid ID');
  }
});

console.log('\nsearch command');
test('finds matches in transcripts', () => {
  const out = run('search "claude" --limit 3 --json', 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
});

test('search returns expected fields', () => {
  const out = run('search "the" --limit 1 --json', 60000);
  const data = JSON.parse(out);
  if (data.length > 0) {
    assert(data[0].sessionId, 'should have sessionId');
    assert(data[0].shortId, 'should have shortId');
    assert(data[0].project, 'should have project');
    assert(data[0].type, 'should have type');
    assert(Array.isArray(data[0].snippets), 'should have snippets array');
  }
});

test('human-readable search works', () => {
  const out = run('search "session" --limit 3', 60000);
  assert(typeof out === 'string', 'should return string output');
});

console.log('\nexport command');
test('exports session as markdown', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`export ${shortId} --format md`);
  assert(out.includes('# Session:'), 'should have markdown header');
});

test('exports session as text', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`export ${shortId} --format text`);
  assert(out.includes('[YOU]') || out.includes('[CLAUDE]'), 'should have text format markers');
});

test('exports session as json', () => {
  const listOut = run('list --limit 20 --json');
  const sessions = JSON.parse(listOut);
  const smallest = sessions.reduce((a, b) => a.size < b.size ? a : b);
  const out = run(`export ${smallest.shortId} --format json`, 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be valid JSON array');
});

console.log('\nhistory command');
test('shows history entries', () => {
  const out = run('history --limit 5 --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
});

test('human-readable history works', () => {
  const out = run('history --limit 5');
  assert(typeof out === 'string', 'should return string');
});

console.log('\nhelp output');
test('--help shows all commands', () => {
  const out = run('--help');
  assert(out.includes('list'), 'should show list command');
  assert(out.includes('search'), 'should show search command');
  assert(out.includes('show'), 'should show show command');
  assert(out.includes('projects'), 'should show projects command');
  assert(out.includes('export'), 'should show export command');
  assert(out.includes('history'), 'should show history command');
});

console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
