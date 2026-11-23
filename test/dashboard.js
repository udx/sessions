#!/usr/bin/env node

// The dashboard page in a real browser: the projects rail, the "No project"
// entry, filtering by agent, and what a refresh keeps and drops.
//
// Runs only when SESSIONS_TEST_CHROME names a Chrome or Chromium binary, on a
// Node that has a WebSocket client of its own (22 or newer). Otherwise it
// says so and passes, like the live Elasticsearch part of the index suite.
//   SESSIONS_TEST_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node test/dashboard.js
// Hermetic: its own transcripts, the tool's own server on a free port, and a
// browser profile of its own, all removed at the end.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.SESSIONS_TEST_CHROME;
if (!CHROME || typeof WebSocket === 'undefined') {
  const why = CHROME ? 'this Node has no WebSocket client; use Node 22 or newer' : 'set SESSIONS_TEST_CHROME to a Chrome binary to run';
  console.log(`\nthe dashboard in a browser\n  \x1b[33m-\x1b[0m skipped (${why})\n\n\x1b[32m0 passed, 0 failed\x1b[0m\n`);
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-dashboard-'));
const now = Date.now();
const HOUR = 3_600_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function write(file, records, ageMs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const at = new Date(now - ageMs);
  utimesSync(file, at, at);
  return file;
}
const claude = (id, cwd, words, ageMs) => write(path.join(root, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`), [
  { type: 'user', cwd, timestamp: new Date(now - ageMs).toISOString(), message: { role: 'user', content: [{ type: 'text', text: words }] } },
  { type: 'assistant', cwd, timestamp: new Date(now - ageMs + 1000).toISOString(), message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Done.' }] } }
], ageMs);
const codex = (id, cwd, words, ageMs) => write(path.join(root, 'codex', 'sessions', '2026', '03', '09', `rollout-2026-03-09T00-00-00-${id}.jsonl`), [
  { type: 'session_meta', timestamp: new Date(now - ageMs).toISOString(), payload: { id, cwd, originator: 'Codex Desktop' } },
  { type: 'turn_context', payload: { cwd, model: 'gpt-test' } },
  { type: 'event_msg', timestamp: new Date(now - ageMs).toISOString(), payload: { type: 'user_message', message: words } },
  { type: 'event_msg', timestamp: new Date(now - ageMs + 1000).toISOString(), payload: { type: 'agent_message', message: 'Done.' } }
], ageMs);

// Three projects, and four conversations Codex's desktop app started without
// one, each in a folder of its own. A Claude session was later run in one of
// those folders.
claude('aaaaaaaa-0000-4000-8000-000000000001', '/work/storefront', 'Add a size filter to the catalog page', 2 * 60_000);
claude('aaaaaaaa-0000-4000-8000-000000000002', '/work/storefront', 'Why is checkout slow on mobile', 5 * HOUR);
claude('aaaaaaaa-0000-4000-8000-000000000003', '/work/billing-api', 'Write a migration for invoice numbers', 2 * HOUR);
claude('aaaaaaaa-0000-4000-8000-000000000004', '/clients/acme/site', 'Update the footer links', 26 * HOUR);
codex('019f0000-0000-7000-8000-000000000001', '/work/billing-api', 'Review the invoice migration', 4 * HOUR);
const FOLDERS = {
  '019f0000-0000-7000-8000-000000000002': '/Users/pat/Documents/Codex/2026-03-09/can-you',
  '019f0000-0000-7000-8000-000000000003': '/Users/pat/Documents/Codex/2026-03-09/can-you-x20',
  '019f0000-0000-7000-8000-000000000004': '/Users/pat/Documents/Codex/2026-03-08/i-ha'
};
const loose = [
  codex('019f0000-0000-7000-8000-000000000002', FOLDERS['019f0000-0000-7000-8000-000000000002'], 'Can you compare two phone plans', 1 * HOUR),
  codex('019f0000-0000-7000-8000-000000000003', FOLDERS['019f0000-0000-7000-8000-000000000003'], 'Can you draft a thank-you note', 6 * HOUR),
  codex('019f0000-0000-7000-8000-000000000004', FOLDERS['019f0000-0000-7000-8000-000000000004'], 'I have a question about tax forms', 28 * HOUR),
  claude('aaaaaaaa-0000-4000-8000-000000000005', FOLDERS['019f0000-0000-7000-8000-000000000002'], 'Pick up the phone plan comparison', 3 * HOUR)
];

// Nothing of this machine: not its settings, not its agents' folders, not
// the desktop app's data. The home directory is the one the fixtures speak
// of, since Codex's conversation folders are under the person's Documents.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key.startsWith('CODEX') || key.startsWith('KIMI') || key === 'ELASTICSEARCH_URL') delete env[key];
}
Object.assign(env, {
  NO_COLOR: '1',
  HOME: '/Users/pat',
  USERPROFILE: '/Users/pat',
  SESSIONS_CLAUDE_DIR: path.join(root, 'claude'),
  SESSIONS_CLAUDE_DESKTOP_DIR: '',
  SESSIONS_CODEX_DIR: path.join(root, 'codex'),
  SESSIONS_KIMI_DIR: path.join(root, 'kimi'),
  SESSIONS_CONFIG: path.join(root, 'absent.yaml')
});
const server = spawn(process.execPath, [CLI, '--serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const profile = path.join(root, 'browser-profile');
let chrome;
const said = (child, pattern, what) => new Promise((resolve, reject) => {
  let text = '';
  const timer = setTimeout(() => reject(new Error(`${what} did not start`)), 20_000);
  // A program that cannot be started says so in an event of its own, which
  // would end this script before it cleans up if nobody listened.
  child.on('error', error => { clearTimeout(timer); reject(new Error(`${what} could not be started: ${error.message}`)); });
  const read = chunk => {
    text += chunk;
    const match = text.match(pattern);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  };
  child.stdout?.setEncoding('utf8').on('data', read);
  child.stderr?.setEncoding('utf8').on('data', read);
});

console.log('\nthe dashboard in a browser');
try {
  const url = await said(server, /Sessions dashboard: (http:\/\/[^\s]+)/, 'the server');
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await said(chrome, /DevTools listening on (ws:\/\/[^\s]+)/, 'the browser');
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push(msg.params.entry.text);
  };
  // A browser that goes away, or stops answering, fails the check instead
  // of leaving it waiting.
  const gone = reason => { for (const { reject } of pending.values()) reject(new Error(reason)); pending.clear(); };
  ws.onclose = () => gone('the browser closed the connection');
  ws.onerror = () => gone('the connection to the browser failed');
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`the browser did not answer ${method}`)); }, 20_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  const page = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, what) => {
    for (let i = 0; i < 100; i++) {
      if (await page(expression)) return;
      await sleep(100);
    }
    throw new Error(`the page never showed ${what}`);
  };
  // What the projects rail shows: [label, count, pressed], and its tooltip.
  const rail = () => page(`[...document.querySelectorAll('#project-list .rail-item')].map(item => [item.querySelector('.rail-name').textContent, item.querySelector('.rail-count').textContent, item.getAttribute('aria-pressed') === 'true'])`);
  const cells = () => page(`[...document.querySelectorAll('#session-list .cell-project')].map(cell => [cell.textContent, cell.title, cell.classList.contains('none')])`);
  // Runs a function in the page with values handed to it as arguments, so
  // no code is put together from them.
  const inPage = async (fn, ...values) => {
    const { result: documentObject } = await cdp('Runtime.evaluate', { expression: 'document' });
    const result = await cdp('Runtime.callFunctionOn', {
      objectId: documentObject.objectId,
      functionDeclaration: String(fn),
      arguments: values.map(value => ({ value })),
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const choose = (list, value) => inPage(function (within, wanted) {
    [...this.querySelector(within).querySelectorAll('.rail-item')].find(item => item.dataset.value === wanted).click();
  }, list, value);
  const refresh = async () => {
    await page(`window.__before = document.querySelector('#refresh-status').textContent; document.querySelector('#refresh-button').click()`);
    await until(`!document.querySelector('#refresh-button').disabled && document.querySelectorAll('#session-list .cell-project, #empty-state:not([hidden])').length > 0`, 'the refreshed list');
    await sleep(150);
  };

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await until(`document.querySelectorAll('#session-list .cell-project').length === 9`, 'the nine sessions');

  await test('real projects are listed by last use, and the rest under one entry at the end', async () => {
    assert.deepEqual(await rail(), [
      ['All projects', '9', true],
      ['storefront', '2', false],
      ['billing-api', '2', false],
      ['site', '1', false],
      ['No project', '4', false]
    ]);
    assert.deepEqual(await page(`['#total-stat', '#projects-stat'].map(id => document.querySelector(id).textContent)`), ['9', '3']);
    const filed = (await cells()).filter(cell => cell[2]);
    assert.equal(filed.length, 4);
    // The cell says so and keeps the folder it ran in for whoever hovers.
    for (const [label, title] of filed) {
      assert.equal(label, 'No project');
      assert.match(title, /^\/Users\/pat\/Documents\/Codex\/2026-03-0[89]\//);
    }
  });

  await test('choosing the entry lists those sessions, each with the command for its own folder', async () => {
    await choose('#project-list', ':none');
    assert.deepEqual((await rail()).at(-1), ['No project', '4', true]);
    assert.deepEqual((await cells()).map(cell => cell[0]), ['No project', 'No project', 'No project', 'No project']);
    const commands = await page(`[...document.querySelectorAll('#session-list .resume-button')].map(button => button.dataset.command)`);
    assert.equal(commands.includes(`cd '${FOLDERS['019f0000-0000-7000-8000-000000000002']}' && codex resume '019f0000-0000-7000-8000-000000000002'`), true, commands.join('\n'));
    assert.equal(commands.includes(`cd '${FOLDERS['019f0000-0000-7000-8000-000000000002']}' && claude --resume 'aaaaaaaa-0000-4000-8000-000000000005'`), true, commands.join('\n'));
  });

  await test('the agent filter narrows it, and its count follows', async () => {
    await choose('#source-list', 'claude');
    assert.deepEqual((await rail()).at(-1), ['No project', '1', true]);
    assert.equal((await cells()).length, 1);
    await choose('#source-list', 'codex');
    assert.deepEqual((await rail()).at(-1), ['No project', '3', true]);
    // Projects with nothing of this agent drop out of the rail; the chosen entry stays.
    assert.deepEqual((await rail()).map(item => item[0]), ['All projects', 'billing-api', 'No project']);
    await choose('#source-list', 'all');
    assert.deepEqual((await rail()).at(-1), ['No project', '4', true]);
  });

  await test('a search narrows it too, and an entry left with nothing stays while it is chosen', async () => {
    const type = text => inPage(function (words) {
      const input = this.querySelector('#search-input');
      input.value = words;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await type('tax forms');
    assert.deepEqual(await rail(), [['All projects', '1', false], ['No project', '1', true]]);
    await type('storefront');
    assert.deepEqual((await rail()).at(-1), ['No project', '0', true]);
    assert.equal((await cells()).length, 0);
    await type('');
    assert.equal((await cells()).length, 4);
  });

  await test('a refresh keeps the choice while such sessions exist and lets go of it when they are gone', async () => {
    await refresh();
    assert.deepEqual((await rail()).at(-1), ['No project', '4', true]);
    assert.equal((await cells()).length, 4);
    for (const file of loose) rmSync(file);
    await refresh();
    await until(`document.querySelectorAll('#session-list .cell-project').length === 5`, 'the five sessions that are left');
    assert.deepEqual(await rail(), [
      ['All projects', '5', true],
      ['storefront', '2', false],
      ['billing-api', '2', false],
      ['site', '1', false]
    ]);
  });

  await test('the page raised no errors', () => {
    assert.deepEqual(problems, []);
  });
  ws.close();
} catch (error) {
  failed++;
  console.log(`  \x1b[31mx\x1b[0m the browser check could not run\n    ${String(error.message).split('\n')[0]}`);
} finally {
  server.kill('SIGTERM');
  chrome?.kill('SIGTERM');
  await sleep(400);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
