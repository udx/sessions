#!/usr/bin/env node

// Runs the test suites one after another and fails if any of them does.
//   node test/run.js              every suite
//   node test/run.js search cli   only the ones named
// Each suite is a plain script, so it can also be run on its own:
//   node test/elastic.js

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// What each suite covers, in the order they run.
const SUITES = {
  cli: 'every command against a few transcripts',
  sources: 'reading Claude Code, Codex and Kimi sessions',
  transcripts: 'subagents, compressed rollouts, damaged files',
  search: 'search without an index',
  elastic: 'the Elasticsearch index, sync and search',
  agents: 'sessions init, sessions guide, and what they claim',
  server: 'the dashboard server',
  markdown: 'how the dashboard renders text'
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter(name => !(name in SUITES));
if (unknown.length > 0) {
  console.error(`No such suite: ${unknown.join(', ')}. There are: ${Object.keys(SUITES).join(', ')}.`);
  process.exit(2);
}

const names = wanted.length > 0 ? wanted : Object.keys(SUITES);
const failed = [];
for (const name of names) {
  console.log(`\n=== ${name}: ${SUITES[name]} ===`);
  const result = spawnSync(process.execPath, [path.join(here, `${name}.js`)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}

if (failed.length > 0) {
  console.error(`\nFailed: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\nAll ${names.length} suites passed.`);
