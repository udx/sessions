#!/usr/bin/env node

// Command-level checks of the CLI. They run against a few transcripts written
// to a temporary directory, so the result is the same on every machine.

import assert from 'assert';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = `node ${path.join(__dirname, 'index.js')}`;
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-cli-'));
const claudeDir = path.join(root, 'claude');
const now = Date.now();

// --- fixtures ---

function turn(type, content, offset, cwd) {
  return {
    type,
    cwd,
    timestamp: new Date(now + offset).toISOString(),
    message: {
      role: type,
      model: type === 'assistant' ? 'claude-test' : undefined,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content
    }
  };
}

function writeSession(project, id, turns, ageMs) {
  const file = path.join(claudeDir, 'projects', project, `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, turns.map(record => JSON.stringify(record)).join('\n') + '\n');
  const date = new Date(now - ageMs);
  utimesSync(file, date, date);
}

const SHOP = '/work/shop-api';
const SITE = '/work/site';
writeSession('-work-shop-api', 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa', [
  turn('user', 'Please look at the session timeout in the checkout handler.', -9_000, SHOP),
  turn('assistant', [
    { type: 'text', text: 'The session timeout comes from the cache layer. Reading the handler.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/work/shop-api/checkout.js' } }
  ], -8_900, SHOP),
  turn('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], -8_800, SHOP),
  turn('user', 'Thanks, ship the fix.', -8_700, SHOP),
  turn('assistant', 'Shipped the fix to the staging cluster.', -8_600, SHOP)
], 60_000);
writeSession('-work-shop-api', 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb', [
  turn('user', 'What is the retry policy for the payment webhook?', -7_000, SHOP),
  turn('assistant', 'The webhook retries three times, then parks the event.', -6_900, SHOP)
], 3_600_000);
writeSession('-work-site', 'cccccccc-1111-4222-8333-cccccccccccc', [
  turn('user', 'Ask claude to rewrite the landing page hero.', -5_000, SITE),
  turn('assistant', 'Rewrote the hero and the pricing table.', -4_900, SITE)
], 7_200_000);

writeFileSync(path.join(claudeDir, 'history.jsonl'), [
  { display: 'Please look at the session timeout in the checkout handler.', timestamp: now - 9_000, project: SHOP, sessionId: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa' },
  { display: 'Thanks, ship the fix.', timestamp: now - 8_700, project: SHOP, sessionId: 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa' },
  { display: 'Ask claude to rewrite the landing page hero.', timestamp: now - 5_000, project: SITE, sessionId: 'cccccccc-1111-4222-8333-cccccccccccc' }
].map(entry => JSON.stringify(entry)).join('\n') + '\n');

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
const env = {
  ...cleanEnv,
  NO_COLOR: '1',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: path.join(root, 'codex'),
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message}`);
  }
}

// These used to need the developer's own transcripts and were skipped without them.
const testData = test;

function run(cmd, timeout = 30000) {
  return execSync(`${CLI} ${cmd}`, { encoding: 'utf8', timeout, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

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

test('--version shows version', () => {
  const out = run('--version');
  assert(/^\d+\.\d+\.\d+/.test(out.trim()), 'should show semver version');
});

console.log('\nprojects command');
testData('returns valid JSON', () => {
  const out = run('projects --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  assert(data.length > 0, 'should have projects');
});

testData('shows project paths and session counts', () => {
  const out = run('projects --json');
  const data = JSON.parse(out);
  for (const p of data) {
    assert(p.path, 'project should have path');
    assert(typeof p.sessionCount === 'number', 'should have sessionCount');
    assert(typeof p.totalSize === 'number', 'should have totalSize');
  }
});

testData('human-readable output works', () => {
  const out = run('projects');
  assert(out.includes('projects'), 'should mention projects');
});

console.log('\nlist command');
testData('lists sessions as JSON', () => {
  const out = run('list --limit 3 --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  assert(data.length > 0, 'should have sessions');
  assert(data.length <= 3, 'should respect limit');
});

testData('sessions have required fields', () => {
  const out = run('list --limit 1 --json');
  const data = JSON.parse(out);
  const s = data[0];
  assert(s.sessionId, 'should have sessionId');
  assert(s.shortId, 'should have shortId');
  assert(s.project, 'should have project');
  assert(s.filePath, 'should have filePath');
  assert(s.firstPrompt !== undefined, 'should have firstPrompt');
});

testData('human-readable list works', () => {
  const out = run('list --limit 3');
  assert(out.includes('sessions'), 'should mention sessions');
});

testData('--project filter works', () => {
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

testData('--full flag provides message counts', () => {
  const out = run('list --limit 1 --full --json');
  const data = JSON.parse(out);
  assert(data[0].messageCount !== undefined, 'should have messageCount with --full');
});

console.log('\nshow command');
testData('shows session by short ID', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --limit 3 --json`);
  const messages = JSON.parse(out);
  assert(Array.isArray(messages), 'should be array');
  assert(messages.length > 0, 'should have messages');
});

testData('--user-only filter works', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --user-only --limit 5 --json`);
  const messages = JSON.parse(out);
  assert(messages.every(m => m.type === 'user'), 'all should be user messages');
});

testData('--assistant-only shows only text messages', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --assistant-only --limit 5 --json`);
  const messages = JSON.parse(out);
  assert(messages.every(m => m.type === 'assistant'), 'all should be assistant messages');
  for (const m of messages) {
    const content = m.message?.content;
    if (Array.isArray(content)) {
      const hasText = content.some(b => b.type === 'text' && b.text && b.text.trim());
      assert(hasText, 'assistant-only messages should have text content');
    }
  }
});

testData('--no-tools hides empty tool-only messages', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --no-tools --limit 10 --json`);
  const messages = JSON.parse(out);
  for (const m of messages) {
    if (m.type === 'assistant') {
      const content = m.message?.content;
      if (Array.isArray(content)) {
        const hasText = content.some(b => b.type === 'text' && b.text && b.text.trim());
        assert(hasText, '--no-tools messages should have text content (not be empty)');
      }
    }
  }
});

testData('--no-tools human-readable has no blank messages', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --no-tools --limit 10`);
  const emptyBlocks = (out.match(/Claude.*\n\n\n/g) || []).length;
  assert(emptyBlocks === 0, `should have no empty Claude blocks, found ${emptyBlocks}`);
});

testData('human-readable show works', () => {
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
testData('finds matches in transcripts', () => {
  const out = run('search "claude" --limit 3 --json', 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
});

testData('search returns expected fields', () => {
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

testData('search --since filters by date', () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const out = run(`search "the" --since ${tomorrow} --limit 5 --json`, 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  assert(data.length === 0, 'future date should return no results');
});

testData('human-readable search works', () => {
  const out = run('search "session" --limit 3', 60000);
  assert(typeof out === 'string', 'should return string output');
});

testData('search -C shows context messages', () => {
  const out = run('search "the" --limit 1 -C 1 --json', 60000);
  const data = JSON.parse(out);
  if (data.length > 0) {
    assert(Array.isArray(data[0].contextMessages), 'should have contextMessages array');
  }
});

testData('search shows occurrence counts in human output', () => {
  const out = run('search "the" --limit 5', 60000);
  assert(typeof out === 'string', 'should return string output');
  assert(out.includes('matches'), 'should show match count header');
});

console.log('\nshow --preview');
testData('--preview shows compact user prompts', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`show ${shortId} --preview`);
  assert(out.includes('Session:'), 'should show session header');
  assert(!/^\u25c0 Claude/m.test(out), 'preview should not show Claude message headers');
});

console.log('\nlist --json display field');
testData('list --json includes display field', () => {
  const out = run('list --limit 1 --json');
  const data = JSON.parse(out);
  assert(data[0].display !== undefined, 'should have display field');
  if (data[0].firstPrompt) {
    assert(data[0].display === data[0].firstPrompt, 'display should match firstPrompt');
  }
});

console.log('\nexport command');
testData('exports session as markdown without empty blocks', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`export ${shortId} --format md`);
  assert(out.includes('# Session:'), 'should have markdown header');
  const emptyBlocks = out.split('---').filter(block => {
    const trimmed = block.trim();
    return trimmed.startsWith('###') && trimmed.split('\n').filter(l => l.trim()).length <= 1;
  });
  assert(emptyBlocks.length === 0, `should have no empty export blocks, found ${emptyBlocks.length}`);
});

testData('exports session as text without empty entries', () => {
  const listOut = run('list --limit 1 --json');
  const sessions = JSON.parse(listOut);
  const shortId = sessions[0].shortId;
  const out = run(`export ${shortId} --format text`);
  assert(out.includes('[YOU]') || out.includes('[CLAUDE]'), 'should have text format markers');
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('[YOU]') || lines[i].startsWith('[CLAUDE]')) {
      const nextLine = lines[i + 1] || '';
      assert(nextLine.trim().length > 0, 'text export entries should not be empty');
    }
  }
});

testData('exports session as json', () => {
  const listOut = run('list --limit 20 --json');
  const sessions = JSON.parse(listOut);
  const smallest = sessions.reduce((a, b) => a.size < b.size ? a : b);
  const out = run(`export ${smallest.shortId} --format json`, 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be valid JSON array');
});

console.log('\nhistory command');
testData('shows history entries with display text', () => {
  const out = run('history --limit 5 --json');
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
});

testData('history human-readable shows actual prompts (not empty)', () => {
  const out = run('history --limit 5');
  assert(typeof out === 'string', 'should return string');
  const lines = out.split('\n').filter(l => l.trim());
  const emptyCount = lines.filter(l => l.trim() === '(empty)').length;
  const contentLines = lines.filter(l => l.startsWith('  ') && !l.includes('entries') && !l.includes('showing'));
  if (contentLines.length > 0) {
    assert(emptyCount < contentLines.length, 'most history entries should have content, not (empty)');
  }
});

testData('history --search filters entries', () => {
  const allOut = run('history --limit 50 --json');
  const allData = JSON.parse(allOut);
  if (allData.length > 0) {
    const firstDisplay = allData[0].display || allData[0].prompt || allData[0].message || '';
    if (firstDisplay.length > 3) {
      const keyword = firstDisplay.slice(0, 10);
      const filteredOut = run(`history --search "${keyword}" --limit 50 --json`);
      const filteredData = JSON.parse(filteredOut);
      assert(filteredData.length > 0, 'search should find matching entries');
      assert(filteredData.length <= allData.length, 'filtered should be <= total');
    }
  }
});

console.log('\nproject filter (encoded names)');
testData('--project matches encoded directory names', () => {
  const projectsOut = run('projects --json');
  const projects = JSON.parse(projectsOut);
  const proj = projects
    .filter(p => p.encoded !== p.path)
    .sort((a, b) => b.encoded.length - a.encoded.length)[0];
  if (proj) {
    const filtered = run(`list --project "${proj.encoded}" --limit 50 --json`);
    const filteredData = JSON.parse(filtered);
    assert(filteredData.length > 0, 'should match by encoded directory name');
    assert(filteredData.every(s => s.project.includes(proj.path)), 'all results should be from matching project');
  }
});

testData('--project is case-insensitive', () => {
  const allOut = run('list --limit 1 --json');
  const all = JSON.parse(allOut);
  if (all.length > 0) {
    const project = all[0].project;
    const upper = project.toUpperCase();
    const filtered = run(`list --project "${upper}" --limit 5 --json`);
    const filteredData = JSON.parse(filtered);
    assert(filteredData.length > 0, 'case-insensitive match should find results');
  }
});

console.log('\nrecap command');
testData('recap returns JSON with expected fields', () => {
  const out = run('recap --days 30 -n 2 --json', 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  if (data.length > 0) {
    assert(data[0].sessionId, 'should have sessionId');
    assert(data[0].shortId, 'should have shortId');
    assert(data[0].project, 'should have project');
    assert(typeof data[0].userCount === 'number', 'should have userCount');
    assert(Array.isArray(data[0].prompts), 'should have prompts array');
  }
});

testData('recap human-readable output works', () => {
  const out = run('recap --days 30 -n 2', 60000);
  assert(out.includes('Recap:'), 'should show recap header');
});

testData('recap --project filters correctly', () => {
  const out = run('recap --days 30 -n 2 --json', 60000);
  const all = JSON.parse(out);
  if (all.length > 0) {
    const project = all[0].project;
    const filtered = run(`recap --project "${project}" --days 30 -n 10 --json`, 60000);
    const filteredData = JSON.parse(filtered);
    assert(filteredData.every(s => s.project.includes(project)), 'all should match project filter');
  }
});

console.log('\nactivity command');
testData('activity returns JSON with expected fields', () => {
  const out = run('activity --days 30 -n 5 --json', 60000);
  const data = JSON.parse(out);
  assert(Array.isArray(data), 'should be array');
  if (data.length > 0) {
    assert(data[0].shortId, 'should have shortId');
    assert(data[0].project, 'should have project');
  }
});

testData('activity human-readable groups by project', () => {
  const out = run('activity --days 30 -n 10', 60000);
  assert(out.includes('Activity:'), 'should show activity header');
});

rmSync(root, { recursive: true, force: true });
console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
