#!/usr/bin/env node

// Tests for agent onboarding: "sessions init", "sessions guide", and the
// promise that what they tell an agent is true of the CLI.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentTargets, applyBlock, guideText, instructionBlock, mentionsOutsideBlock, removeBlock } from './agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-agents-'));

let passed = 0;
let failed = 0;
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

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key.startsWith('CLAUDE') || key === 'CODEX_HOME' || key === 'KIMI_CODE_HOME' || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
function homes(name) {
  const base = path.join(root, name);
  return {
    base,
    claude: path.join(base, 'claude'),
    codex: path.join(base, 'codex'),
    kimi: path.join(base, 'kimi'),
    env: {
      ...cleanEnv,
      NO_COLOR: '1',
      SESSIONS_CLAUDE_DIR: path.join(base, 'claude'),
      SESSIONS_CODEX_DIR: path.join(base, 'codex'),
      SESSIONS_KIMI_DIR: path.join(base, 'kimi'),
      SESSIONS_CONFIG: path.join(base, 'absent.yaml')
    }
  };
}
const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
function ok(args, env) {
  const result = cli(args, env);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
const read = file => readFileSync(file, 'utf8');
const block = instructionBlock();

console.log('\nthe managed block');

test('is short, self-contained and marked', () => {
  assert.equal(block.startsWith('<!-- sessions:start'), true);
  assert.equal(block.endsWith('<!-- sessions:end -->\n'), true);
  assert.equal(Buffer.byteLength(block) < 2000, true, `${Buffer.byteLength(block)} bytes is too much to load into every session`);
  assert.match(block, /sessions search/);
  assert.match(block, /sessions guide/);
});

test('is added once, updated in place, and removed cleanly', () => {
  assert.deepEqual(applyBlock(null), { text: block, change: 'created' });
  assert.deepEqual(applyBlock(''), { text: block, change: 'added' });
  const own = '# My rules\n\nBe brief.\n';
  const added = applyBlock(own);
  assert.equal(added.change, 'added');
  assert.equal(added.text, `${own}\n${block}`);
  assert.equal(applyBlock('No newline at the end').text, `No newline at the end\n\n${block}`);
  assert.deepEqual(applyBlock(added.text), { text: added.text, change: 'unchanged' });

  // An older note is replaced where it stands, and text after it survives.
  const older = `${own}\n<!-- sessions:start - an earlier wording -->\nold advice with $& and $1 in it\n<!-- sessions:end -->\n\n## After\n`;
  const updated = applyBlock(older);
  assert.equal(updated.change, 'updated');
  assert.equal(updated.text, `${own}\n${block}\n## After\n`);
  assert.equal(updated.text.includes('old advice'), false);

  assert.deepEqual(removeBlock(added.text), { text: own, change: 'removed' });
  assert.deepEqual(removeBlock(block), { text: '', change: 'removed' });
  assert.equal(removeBlock(updated.text).text, `${own}\n## After\n`);
  assert.deepEqual(removeBlock(own), { text: own, change: 'absent' });
  assert.deepEqual(removeBlock(null), { text: '', change: 'absent' });
});

test('an older hand-written note next to it is noticed', () => {
  assert.equal(mentionsOutsideBlock(`Use \`sessions search <query>\` for history.\n\n${block}`), true);
  assert.equal(mentionsOutsideBlock(`# Rules\n\n${block}`), false);
  assert.equal(mentionsOutsideBlock('We hold weekly planning sessions.'), false);
});

test('each agent has one global file, and its home can move', () => {
  const targets = agentTargets({}, '/home/pat');
  assert.deepEqual(targets.map(target => [target.agent, target.file]), [
    ['claude', '/home/pat/.claude/CLAUDE.md'],
    ['codex', '/home/pat/.codex/AGENTS.md'],
    ['kimi', '/home/pat/.kimi-code/AGENTS.md']
  ]);
  assert.equal(targets[1].shadowedBy, '/home/pat/.codex/AGENTS.override.md');
  const moved = agentTargets({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', KIMI_CODE_HOME: '/k' }, '/home/pat');
  assert.deepEqual(moved.map(target => target.file), ['/c/CLAUDE.md', '/x/AGENTS.md', '/k/AGENTS.md']);
});

console.log('\nsessions init');

test('writes the note for each installed agent and skips the rest', () => {
  const home = homes('fresh');
  mkdirSync(home.claude, { recursive: true });
  mkdirSync(home.codex, { recursive: true });
  writeFileSync(path.join(home.claude, 'CLAUDE.md'), '# Mine\n\nKeep answers short.\n');

  const out = ok(['init'], home.env);
  const lines = out.split('\n');
  assert.match(lines[0], /^Claude Code {2}.*CLAUDE\.md +added$/);
  assert.match(lines[1], /^Codex {8}.*AGENTS\.md +created$/);
  assert.match(lines[2], /^Kimi Code {4}.*AGENTS\.md +not installed \(no .*kimi\)$/);
  assert.match(out, /Sessions started from now on will read it\. "sessions init --remove" takes it out again\./);

  assert.equal(read(path.join(home.claude, 'CLAUDE.md')), `# Mine\n\nKeep answers short.\n\n${block}`);
  assert.equal(read(path.join(home.codex, 'AGENTS.md')), block);
  assert.equal(existsSync(home.kimi), false, 'an agent that is not installed gets no directory');

  // Again: nothing to do, and nothing rewritten.
  const again = ok(['init'], home.env);
  assert.match(again, /CLAUDE\.md +already up to date\n/);
  assert.match(again, /AGENTS\.md +already up to date\n/);
  assert.doesNotMatch(again, /Sessions started from now on/);
});

test('--dry-run changes nothing and --print only prints', () => {
  const home = homes('dry');
  mkdirSync(home.claude, { recursive: true });
  const out = ok(['init', '--dry-run'], home.env);
  assert.match(out, /^Claude Code {2}.*CLAUDE\.md +would create$/m);
  assert.equal(existsSync(path.join(home.claude, 'CLAUDE.md')), false);
  assert.equal(ok(['init', '--print'], home.env), block);
  assert.equal(existsSync(path.join(home.claude, 'CLAUDE.md')), false);
});

test('--remove takes the note out and leaves everything else', () => {
  const home = homes('remove');
  mkdirSync(home.claude, { recursive: true });
  mkdirSync(home.codex, { recursive: true });
  const mine = '# Mine\n\nKeep answers short.\n';
  writeFileSync(path.join(home.claude, 'CLAUDE.md'), mine);
  ok(['init'], home.env);
  const out = ok(['init', '--remove'], home.env);
  assert.match(out, /CLAUDE\.md +removed\n/);
  assert.match(out, /AGENTS\.md +removed\n/);
  assert.equal(read(path.join(home.claude, 'CLAUDE.md')), mine);
  assert.equal(existsSync(path.join(home.codex, 'AGENTS.md')), false, 'a file that held only the note is removed');
  assert.match(ok(['init', '--remove'], home.env), /CLAUDE\.md +nothing to remove\n/);
});

test('--agent limits it, and an unknown agent is refused', () => {
  const home = homes('one');
  mkdirSync(home.claude, { recursive: true });
  mkdirSync(home.codex, { recursive: true });
  const out = ok(['init', '--agent', 'codex'], home.env);
  assert.equal(out.split('\n')[0].startsWith('Codex'), true);
  assert.doesNotMatch(out, /Claude Code/);
  assert.equal(existsSync(path.join(home.claude, 'CLAUDE.md')), false);
  const rows = JSON.parse(ok(['init', '--agent', 'claude', '--agent', 'codex', '--json'], home.env));
  assert.deepEqual(rows.map(row => [row.agent, row.change]), [['claude', 'created'], ['codex', 'unchanged']]);
  const bad = cli(['init', '--agent', 'cursor'], home.env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown agent "cursor"\. Expected one of: claude, codex, kimi\./);
});

test('says when the note will not be read or repeats older text', () => {
  const home = homes('notes');
  mkdirSync(home.claude, { recursive: true });
  mkdirSync(home.codex, { recursive: true });
  writeFileSync(path.join(home.codex, 'AGENTS.override.md'), 'Temporary override.\n');
  writeFileSync(path.join(home.claude, 'CLAUDE.md'), '- Use `sessions search <query>` to look things up.\n');
  const out = ok(['init'], home.env);
  assert.match(out, /Codex reads .*AGENTS\.override\.md instead for as long as that file has content/);
  assert.match(out, /CLAUDE\.md also describes sessions outside this note; that older text can go/);
});

test('with no agent installed there is nothing to do', () => {
  const home = homes('none');
  const result = cli(['init'], home.env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Claude Code, Codex or Kimi Code installation was found/);
  assert.equal(existsSync(home.base), false);
});

console.log('\nsessions guide and --help');

const helpEnv = homes('help').env;
const helpOf = new Map();
function help(command) {
  if (!helpOf.has(command)) helpOf.set(command, ok(command ? [command, '--help'] : ['--help'], helpEnv));
  return helpOf.get(command);
}

// Every command a text shows, and every flag it shows with that command, has
// to exist. A command is shown at the start of an indented line (the guide and
// --help) or inside backticks (the note); prose is left alone.
function assertCommandsExist(text, label) {
  const commands = new Set((help('').match(/^ {2}([a-z]+)\b/gm) || []).map(line => line.trim()));
  const shown = [
    ...[...text.matchAll(/^ {2}sessions ([a-z]+)\b(.*)$/gm)],
    ...[...text.matchAll(/`sessions ([a-z]+)\b([^`]*)`/g)]
  ];
  let checked = 0;
  for (const [, command, rest] of shown) {
    assert.equal(commands.has(command), true, `${label} shows "sessions ${command}", which is not a command`);
    for (const flag of rest.match(/(?<![\w-])--?[a-zA-Z][a-z-]*/g) || []) {
      const pattern = new RegExp(`(^|[\\s,])${flag}([\\s,=]|$)`, 'm');
      assert.match(help(command), pattern, `${label} uses "${flag}" with "sessions ${command}", which does not accept it`);
      checked++;
    }
  }
  return checked;
}

test('the guide fits one screen and only describes what exists', () => {
  const guide = ok(['guide'], helpEnv);
  assert.equal(guide, guideText());
  assert.equal(guide.split('\n').length <= 45, true);
  assert.equal(guide.split('\n').every(line => line.length <= 100), true);
  assert.equal(assertCommandsExist(guide, 'the guide') > 15, true);
});

test('the note only describes what exists', () => {
  // Flags named on their own in the note belong to search or show.
  assert.equal(assertCommandsExist(block, 'the note') >= 4, true);
  for (const flag of ['-p', '--days', '--source', '--role', '--tools', '--session']) assert.match(help('search'), new RegExp(`${flag}[ ,]`), flag);
  for (const flag of ['--around', '-C', '--user-only', '-n']) assert.match(help('show'), new RegExp(`${flag}[ ,]`), flag);
});

test('--help ends with the commands that matter and points at the guide', () => {
  const text = help('');
  assert.match(text, /Most used:\n {2}sessions search "deploy staging"/);
  assert.match(text, /sessions guide +the whole tool in one screen, written for agents\n?$/);
  assert.equal(assertCommandsExist(text.slice(text.indexOf('Most used:')), '--help') >= 2, true);
  for (const command of ['guide', 'init', 'search', 'show', 'list', 'recap', 'activity', 'projects', 'history', 'export', 'sync', 'label', 'labels', 'serve']) {
    assert.match(text, new RegExp(`^ {2}${command}\\b`, 'm'), command);
  }
});

rmSync(root, { recursive: true, force: true });
console.log(`\n\x1b[${failed ? '31' : '32'}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
