#!/usr/bin/env node

// Tests for the Elasticsearch backend.
//
// Three layers:
//   1. unit tests for config resolution, the query language, and documents
//   2. CLI tests against an in-process fake Elasticsearch (always run)
//   3. CLI tests against a real cluster, only when SESSIONS_TEST_ES_URL is set:
//        SESSIONS_TEST_ES_URL=http://127.0.0.1:9220 node test-elastic.js
//      They use their own index and remove it afterwards.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLoopbackUrl, isValidIndexName, loadConfig, normalizeBackend } from './config.js';
import {
  CREATED_BY,
  HIGHLIGHT_CLOSE,
  HIGHLIGHT_OPEN,
  MAX_TEXT_CHARS,
  SCHEMA_VERSION,
  buildSearchBody,
  collectSessionDocs,
  compareWithIndex,
  createClient,
  indexDefinition,
  isInjectedUserText,
  mergeHighlights,
  parseLabel,
  parseQuery,
  snapshotDate,
  snapshotName,
  syncIndex,
  toolInputText
} from './elastic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'index.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sessions-elastic-'));
const claudeDir = path.join(root, 'claude');
const codexDir = path.join(root, 'codex');
const kimiDir = path.join(root, 'kimi');
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const ALPHA_ID = 'aaaaaaaa-1111-4222-8333-aaaaaaaaaaaa';
const BETA_ID = 'bbbbbbbb-1111-4222-8333-bbbbbbbbbbbb';
const CODEX_ID = '019f0000-1111-7222-8333-abcdefabcdef';
const KIMI_ID = 'eeeeeeee-1111-4222-8333-eeeeeeeeeeee';
const TOTAL_SESSIONS = 4;
const TOTAL_MESSAGES = 15;

// --- fixtures ---

function writeJsonl(filePath, records) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

function claudeMessage(type, content, offset, cwd) {
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

const alphaPath = path.join(claudeDir, 'projects', '-workspace-alpha', `${ALPHA_ID}.jsonl`);
const betaPath = path.join(claudeDir, 'projects', '-workspace-beta', `${BETA_ID}.jsonl`);
const codexPath = path.join(codexDir, 'sessions', '2026', '07', '16', `rollout-2026-07-16T00-00-00-${CODEX_ID}.jsonl`);
const kimiWorkDir = '/workspace/kimi';
const kimiPath = path.join(kimiDir, 'sessions', createHash('md5').update(kimiWorkDir).digest('hex'), KIMI_ID, 'context.jsonl');
// A fixed modification time, so restoring a fixture restores its fingerprint.
const FIXTURE_TIME = new Date(Math.floor(now / 1000) * 1000 - 60_000);

const alphaMessages = () => [
  claudeMessage('user', 'Please fix the authentication bug in the login flow.', -9_000, '/workspace/alpha'),
  claudeMessage('assistant', 'I traced the authentication bug to streamSessionMessages in tools/sessions/index.js.', -8_900, '/workspace/alpha'),
  claudeMessage('assistant', [
    { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "fix login"', description: 'Commit the fix' } }
  ], -8_800, '/workspace/alpha'),
  claudeMessage('user', 'Great, now deploy it to staging.', -8_700, '/workspace/alpha'),
  claudeMessage('assistant', 'Deployed. Release commit ba7d5f58a1c is live.', -8_600, '/workspace/alpha')
];

const betaMessages = () => [
  claudeMessage('user', 'Let us talk about pickleball scheduling.', -7_000, '/workspace/beta'),
  claudeMessage('assistant', 'Courts are booked through the membership portal.', -6_900, '/workspace/beta'),
  claudeMessage('user', 'And separately, the kubernetes cluster needs rightsizing.', -6_800, '/workspace/beta'),
  claudeMessage('assistant', 'Noted: rightsizing the cluster next week.', -6_700, '/workspace/beta'),
  claudeMessage('assistant', 'The index lists every js module.', -6_600, '/workspace/beta')
];

function writeFixture(filePath, records) {
  writeJsonl(filePath, records);
  utimesSync(filePath, FIXTURE_TIME, FIXTURE_TIME);
}

function writeFixtures() {
  writeFixture(alphaPath, alphaMessages());
  writeFixture(betaPath, betaMessages());
  writeFixture(codexPath, [
    { type: 'session_meta', timestamp: iso(-5_000), payload: { id: CODEX_ID, session_id: CODEX_ID, cwd: '/workspace/alpha', timestamp: iso(-5_000) } },
    { type: 'turn_context', timestamp: iso(-4_900), payload: { cwd: '/workspace/alpha', model: 'gpt-test' } },
    { type: 'response_item', timestamp: iso(-4_800), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize the elasticsearch snapshot design.' }] } },
    { type: 'response_item', timestamp: iso(-4_700), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The snapshot index is semi-ephemeral: submission-receipt.json is archived.' }] } },
    { type: 'response_item', timestamp: iso(-4_600), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat editorial-revision.md"}', call_id: 'call-1' } }
  ]);
  mkdirSync(kimiDir, { recursive: true });
  writeFileSync(path.join(kimiDir, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: kimiWorkDir }] }));
  writeFixture(kimiPath, [
    { role: 'user', content: 'Kimi question about dashboards.' },
    { role: 'assistant', content: [{ type: 'text', text: 'Kimi answer mentions grafana panels.' }] }
  ]);
}
writeFixtures();

const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (key.startsWith('SESSIONS_') || key === 'ELASTICSEARCH_URL') delete cleanEnv[key];
}
const baseEnv = {
  ...cleanEnv,
  NO_COLOR: '1',
  TZ: 'UTC',
  SESSIONS_CLAUDE_DIR: claudeDir,
  SESSIONS_CODEX_DIR: codexDir,
  SESSIONS_KIMI_DIR: kimiDir,
  SESSIONS_CONFIG: path.join(root, 'absent-config.yaml')
};

function cli(args, env = baseEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function ok(args, env = baseEnv) {
  const result = await cli(args, env);
  assert.equal(result.status, 0, `command failed: ${args.join(' ')}\n${result.stderr}`);
  return result;
}

async function json(args, env = baseEnv) {
  return JSON.parse((await ok([...args, '--json'], env)).stdout);
}

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
    console.log(`    ${error.message}`);
  }
}

// --- fake Elasticsearch ---
//
// Implements just enough of the REST API for the CLI to run against it: bulk
// partial updates and deletes, reindex, delete-by-query, aliases, and the
// label endpoints. Text queries return whatever state.searchResponse says.

function createFakeElastic() {
  const state = {
    indices: new Map(),
    requests: [],
    failBulkIds: new Set(),
    failRefresh: false,
    // Bulk requests answered before the cluster "goes away"; null means never.
    bulkBudget: null,
    searchResponse: null,
    url: null
  };

  const sessionKeysOf = (query) => query?.terms?.session_key ||
    (query?.bool?.filter || []).map(clause => clause.terms?.session_key).find(Boolean) || [];

  const search = (entry, index, body) => {
    const docs = [...entry.docs.entries()].map(([id, doc]) => ({ id, doc }));
    const filters = body.query?.bool?.filter || (body.query?.term ? [body.query] : []);
    const term = name => filters.map(clause => clause.term?.[name]).find(value => value !== undefined);

    if (body.aggs?.kinds) {
      const count = kind => docs.filter(({ doc }) => doc.kind === kind).length;
      return { aggregations: { kinds: { buckets: [{ key: 'message', doc_count: count('message') }, { key: 'session', doc_count: count('session') }] } } };
    }
    if (term('kind') === 'session') {
      // Session lookups: optionally by id (exact, short, or prefix) and by label.
      const wantedId = filters.map(clause => clause.bool?.should?.[0]?.term?.session_id).find(Boolean);
      const labelTerms = filters.flatMap(clause => Object.entries(clause.term || {}))
        .filter(([field]) => field.startsWith('labels.'))
        .map(([field, spec]) => [field.slice('labels.'.length), String(spec.value).toLowerCase()]);
      const hits = docs.filter(({ doc }) => doc.kind === 'session')
        .filter(({ doc }) => !wantedId || doc.session_id === wantedId || doc.short_id === wantedId || doc.session_id.startsWith(wantedId))
        .filter(({ doc }) => labelTerms.every(([key, value]) => [doc.labels?.[key]].flat().some(item => String(item).toLowerCase() === value)))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, doc }) => ({ _id: id, _source: doc, sort: [doc.session_key] }));
      return { hits: { hits } };
    }
    if (body._source === false && term('kind') === 'message' && term('session_key') && body.sort?.[0]?.seq) {
      const hits = docs.filter(({ doc }) => doc.kind === 'message' && doc.session_key === term('session_key'))
        .sort((a, b) => a.doc.seq - b.doc.seq)
        .map(({ id, doc }) => ({ _id: id, sort: [doc.seq] }));
      return { hits: { hits } };
    }
    const response = typeof state.searchResponse === 'function' ? state.searchResponse(body, index) : state.searchResponse;
    return response || { took: 1, hits: { total: { value: 0 }, hits: [] }, aggregations: { sessions: { value: 0 } } };
  };

  const routes = async (method, pathname, query, body) => {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && parts.length === 0) {
      return [200, { cluster_name: 'fake', version: { number: '8.0.0-fake' } }];
    }
    if (method === 'POST' && parts[0] === '_aliases') {
      for (const action of body.actions) {
        if (action.remove) state.indices.get(action.remove.index)?.aliases.delete(action.remove.alias);
        if (action.add) state.indices.get(action.add.index)?.aliases.add(action.add.alias);
      }
      return [200, { acknowledged: true }];
    }
    if (method === 'POST' && parts[0] === '_reindex') {
      const from = state.indices.get(body.source.index);
      const to = state.indices.get(body.dest.index);
      const keys = new Set(sessionKeysOf(body.source.query));
      const onlyEnriched = Boolean(body.source.query?.bool?.should);
      let total = 0;
      for (const [id, doc] of from.docs) {
        if (!keys.has(doc.session_key)) continue;
        if (onlyEnriched && !doc.labels && !doc.notes) continue;
        const copy = body.source._source
          ? Object.fromEntries(body.source._source.filter(field => doc[field] !== undefined).map(field => [field, doc[field]]))
          : structuredClone(doc);
        to.docs.set(id, copy);
        total++;
      }
      return [200, { total, failures: [] }];
    }

    const [name, verb, target] = parts;
    if (parts.length === 1) {
      if (method === 'PUT') {
        if (state.indices.has(name)) return [400, { error: { type: 'resource_already_exists_exception', reason: 'exists' } }];
        state.indices.set(name, { definition: body, meta: body.mappings?._meta || {}, docs: new Map(), aliases: new Set() });
        return [200, { acknowledged: true }];
      }
      if (method === 'DELETE') {
        return state.indices.delete(name) ? [200, { acknowledged: true }] : [404, { error: { type: 'index_not_found_exception', reason: 'missing' } }];
      }
      if (method === 'GET' && name.endsWith('*')) {
        const prefix = name.slice(0, -1);
        const out = {};
        for (const [index, entry] of state.indices) {
          if (!index.startsWith(prefix)) continue;
          out[index] = { aliases: Object.fromEntries([...entry.aliases].map(alias => [alias, {}])), mappings: { _meta: entry.meta } };
        }
        return [200, out];
      }
    }

    // An index path may be addressed through its alias.
    const resolve = (wanted) => {
      if (state.indices.has(wanted)) return [wanted, state.indices.get(wanted)];
      for (const [index, entry] of state.indices) {
        if (entry.aliases.has(wanted)) return [index, entry];
      }
      return [null, null];
    };
    const [index, entry] = resolve(name);
    if (!entry) return [404, { error: { type: 'index_not_found_exception', reason: `no such index [${name}]` } }];

    if (verb === '_mapping' && method === 'GET') return [200, { [index]: { mappings: { _meta: entry.meta } } }];
    if (verb === '_mapping' && method === 'PUT') {
      entry.meta = body._meta;
      return [200, { acknowledged: true }];
    }
    if (verb === '_settings') return [200, { acknowledged: true }];
    if (verb === '_refresh') {
      return state.failRefresh ? [500, { error: { type: 'boom', reason: 'refresh failed' } }] : [200, {}];
    }
    if (verb === '_stats') return [200, { _all: { primaries: { store: { size_in_bytes: 4096 } } } }];
    if (verb === '_search') return [200, search(entry, index, body)];
    if (verb === '_delete_by_query') {
      const keys = new Set(sessionKeysOf(body.query));
      const orphans = Boolean(body.query?.bool?.must_not?.exists);
      let deleted = 0;
      for (const [id, doc] of [...entry.docs]) {
        if (orphans ? doc.kind === undefined : keys.has(doc.session_key)) {
          entry.docs.delete(id);
          deleted++;
        }
      }
      return [200, { deleted }];
    }
    if (verb === '_bulk') {
      if (state.bulkBudget !== null && state.bulkBudget-- <= 0) {
        return [503, { error: { type: 'unavailable', reason: 'simulated outage' } }];
      }
      const lines = body.split('\n').filter(Boolean);
      const items = [];
      let errors = false;
      for (let i = 0; i < lines.length; i++) {
        const action = JSON.parse(lines[i]);
        if (action.delete) {
          entry.docs.delete(action.delete._id);
          items.push({ delete: { _id: action.delete._id, status: 200 } });
          continue;
        }
        const payload = JSON.parse(lines[++i]);
        const id = action.update._id;
        if (state.failBulkIds.has(id)) {
          errors = true;
          items.push({ update: { _id: id, status: 400, error: { type: 'mapper_parsing_exception', reason: 'simulated failure' } } });
          continue;
        }
        entry.docs.set(id, { ...(entry.docs.get(id) || {}), ...payload.doc });
        items.push({ update: { _id: id, status: 200 } });
      }
      return [200, { errors, items }];
    }
    if (verb === '_update') {
      const doc = entry.docs.get(target);
      if (!doc) return [404, { error: { type: 'document_missing_exception', reason: 'missing' } }];
      const labels = { ...(doc.labels || {}), ...body.script.params.set };
      for (const key of body.script.params.remove) delete labels[key];
      if (Object.keys(labels).length > 0) doc.labels = labels;
      else delete doc.labels;
      return [200, { result: 'updated', get: { _source: doc.labels ? { labels: doc.labels } : {} } }];
    }
    if (verb === '_source') {
      const doc = entry.docs.get(target);
      return doc ? [200, doc.labels ? { labels: doc.labels } : {}] : [404, { error: 'missing' }];
    }
    if (verb === '_mget') {
      return [200, { docs: body.ids.map(id => ({ _id: id, found: entry.docs.has(id), _source: { labels: entry.docs.get(id)?.labels } })) }];
    }
    return [404, { error: `unhandled ${method} ${pathname}` }];
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://localhost');
      const isNdjson = (req.headers['content-type'] || '').includes('ndjson');
      const body = raw ? (isNdjson ? raw : JSON.parse(raw)) : undefined;
      state.requests.push({ method: req.method, path: url.pathname, body });
      const [status, payload] = await routes(req.method, url.pathname, url.searchParams, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  return {
    state,
    start: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        state.url = `http://127.0.0.1:${server.address().port}`;
        resolve(state.url);
      });
    }),
    stop: () => new Promise(resolve => server.close(resolve)),
    reset: () => {
      state.indices.clear();
      state.requests.length = 0;
      state.failBulkIds.clear();
      state.failRefresh = false;
      state.bulkBudget = null;
      state.searchResponse = null;
    }
  };
}

function seedSnapshot(state, name, { alias = null, meta = { created_by: CREATED_BY, schema: SCHEMA_VERSION } } = {}) {
  state.indices.set(name, { definition: {}, meta, docs: new Map(), aliases: new Set(alias ? [alias] : []) });
}

function cannedHit(index) {
  return {
    took: 2,
    hits: {
      total: { value: 3 },
      hits: [{
        _index: index,
        fields: { session_key: [`claude:${ALPHA_ID}`] },
        inner_hits: {
          messages: {
            hits: {
              total: { value: 3 },
              hits: [{
                _score: 4.25,
                _source: {
                  session_key: `claude:${ALPHA_ID}`,
                  session_id: ALPHA_ID,
                  short_id: 'aaaaaaaa',
                  source: 'claude',
                  project: '/workspace/alpha',
                  role: 'assistant',
                  seq: 1,
                  timestamp: iso(-8_900),
                  model: 'claude-test',
                  tools: [],
                  has_text: true,
                  preview: 'I traced the authentication bug'
                },
                highlight: { text: [`I traced the ${HIGHLIGHT_OPEN}authentication${HIGHLIGHT_CLOSE} ${HIGHLIGHT_OPEN}bug${HIGHLIGHT_CLOSE} to the\nlogin flow`] }
              }]
            }
          }
        }
      }]
    },
    aggregations: { sessions: { value: 1 } }
  };
}

// --- 1. unit tests ---

console.log('\nconfig');

await test('environment URL wins over the config file', async () => {
  const file = path.join(root, 'config-a.yaml');
  writeFileSync(file, 'elasticsearch:\n  url: http://127.0.0.1:1111\n  index: fromfile\n  keep: 3\n  auto_sync: 5\nsearch:\n  backend: es\n');
  const fromFile = await loadConfig({ env: { SESSIONS_CONFIG: file } });
  assert.equal(fromFile.elasticsearch.url, 'http://127.0.0.1:1111');
  assert.equal(fromFile.elasticsearch.index, 'fromfile');
  assert.equal(fromFile.elasticsearch.keep, 3);
  assert.equal(fromFile.elasticsearch.autoSyncMinutes, 5);
  assert.equal(fromFile.search.backend, 'elasticsearch');
  assert.equal(fromFile.loaded, true);
  const fromEnv = await loadConfig({ env: { SESSIONS_CONFIG: file, SESSIONS_ES_URL: 'http://127.0.0.1:2222', SESSIONS_ES_INDEX: 'fromenv', SESSIONS_ES_AUTO_SYNC: '0' } });
  assert.equal(fromEnv.elasticsearch.url, 'http://127.0.0.1:2222');
  assert.equal(fromEnv.elasticsearch.index, 'fromenv');
  assert.equal(fromEnv.elasticsearch.autoSyncMinutes, 0);
  const fromFlag = await loadConfig({ env: { SESSIONS_CONFIG: file, SESSIONS_ES_URL: 'http://127.0.0.1:2222' }, overrides: { url: 'http://127.0.0.1:3333' } });
  assert.equal(fromFlag.elasticsearch.url, 'http://127.0.0.1:3333');
});

await test('generic ELASTICSEARCH_URL is never used', async () => {
  const config = await loadConfig({ env: { SESSIONS_CONFIG: path.join(root, 'absent.yaml'), ELASTICSEARCH_URL: 'https://shared.example.com' } });
  assert.equal(config.elasticsearch.url, null);
  assert.equal(config.search.backend, 'auto');
  assert.equal(config.elasticsearch.autoSyncMinutes, 0);
  assert.equal(config.loaded, false);
});

await test('auto_sync accepts minutes or a switch', async () => {
  const file = path.join(root, 'config-auto.yaml');
  const read = async (value) => {
    writeFileSync(file, `elasticsearch:\n  url: http://127.0.0.1:1\n  auto_sync: ${value}\n`);
    return (await loadConfig({ env: { SESSIONS_CONFIG: file } })).elasticsearch.autoSyncMinutes;
  };
  assert.equal(await read('true'), 10);
  assert.equal(await read('false'), 0);
  assert.equal(await read('1'), 1);
  assert.equal(await read('0.5'), 0.5);
  assert.equal(await read('nonsense'), 0);
});

await test('malformed config produces a warning, not a crash', async () => {
  const file = path.join(root, 'config-bad.yaml');
  writeFileSync(file, 'elasticsearch: [unclosed\n');
  const config = await loadConfig({ env: { SESSIONS_CONFIG: file } });
  assert.match(config.warning, /Ignoring .*config-bad\.yaml/);
  assert.equal(config.elasticsearch.url, null);
  writeFileSync(file, '- just\n- a list\n');
  assert.match((await loadConfig({ env: { SESSIONS_CONFIG: file } })).warning, /YAML mapping/);
});

await test('backend names and unknown values', async () => {
  assert.equal(normalizeBackend('ES'), 'elasticsearch');
  assert.equal(normalizeBackend('files'), 'local');
  assert.equal(normalizeBackend('bogus'), null);
  const config = await loadConfig({ env: { SESSIONS_CONFIG: path.join(root, 'absent.yaml'), SESSIONS_SEARCH_BACKEND: 'bogus' } });
  assert.match(config.warning, /Unknown search backend/);
  assert.equal(config.search.backend, 'auto');
});

await test('loopback detection guards remote hosts', () => {
  for (const url of ['http://localhost:9200', 'http://127.0.0.1:9220', 'http://127.8.9.1', 'http://[::1]:9200', 'http://host.docker.internal:9200', 'http://es.localhost']) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ['https://es.example.com', 'http://10.0.0.5:9200', 'http://127.0.0.1.evil.com', 'http://192.168.1.4:9200', 'not a url']) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

await test('index names are validated', () => {
  assert.equal(isValidIndexName('sessions'), true);
  assert.equal(isValidIndexName('sessions-test_1.x'), true);
  for (const name of ['Sessions', '-sessions', 'ses sions', 'ses*', '', 'a/b']) assert.equal(isValidIndexName(name), false, name);
});

console.log('\nquery language');

await test('parses terms, phrases, OR, and NOT', () => {
  const parsed = parseQuery('deploy "exact phrase" staging OR prod NOT legacy');
  assert.deepEqual(parsed.groups, [
    [{ type: 'term', text: 'deploy' }],
    [{ type: 'phrase', text: 'exact phrase' }],
    [{ type: 'term', text: 'staging' }, { type: 'term', text: 'prod' }]
  ]);
  assert.deepEqual(parsed.excluded, [{ type: 'term', text: 'legacy' }]);
});

await test('a dash is never an operator', () => {
  const parsed = parseQuery('rm -rf --no-verify cherry-pick gh pr merge --admin');
  assert.deepEqual(parsed.groups.map(group => group[0].text), ['rm', '-rf', '--no-verify', 'cherry-pick', 'gh', 'pr', 'merge', '--admin']);
  assert.equal(parsed.excluded.length, 0);
});

await test('grep habits are understood', () => {
  assert.deepEqual(parseQuery('devin.*prompt').groups, [[{ type: 'near', text: 'devin prompt' }]]);
  assert.deepEqual(parseQuery('harvest\\|fireflies').groups, [[{ type: 'term', text: 'harvest' }, { type: 'term', text: 'fireflies' }]]);
  assert.deepEqual(parseQuery('a|b c').groups, [[{ type: 'term', text: 'a' }, { type: 'term', text: 'b' }], [{ type: 'term', text: 'c' }]]);
  assert.deepEqual(parseQuery('create.*session\\|v1/sessions.*POST').groups, [
    [{ type: 'near', text: 'create session' }, { type: 'near', text: 'v1/sessions POST' }]
  ]);
  assert.deepEqual(parseQuery('api\\.devin\\.ai').groups, [[{ type: 'term', text: 'api.devin.ai' }]]);
  assert.deepEqual(parseQuery('trailing.*').groups, [[{ type: 'term', text: 'trailing' }]]);
  assert.equal(JSON.stringify(buildSearchBody({ query: 'devin.*prompt' })).includes('{"match_phrase":{"text":{"query":"devin prompt","slop":40,"boost":3}}}'), true);
});

await test('terms the tokenizer would drop are ignored', () => {
  assert.deepEqual(parseQuery('curl | jq').groups, [[{ type: 'term', text: 'curl' }], [{ type: 'term', text: 'jq' }]]);
  assert.deepEqual(parseQuery('&& => "()"').groups, []);
  assert.deepEqual(parseQuery('a -> b').groups.map(group => group[0].text), ['a', '->', 'b']);
});

await test('dangling operators and open quotes degrade gracefully', () => {
  assert.deepEqual(parseQuery('deploy OR').groups, [[{ type: 'term', text: 'deploy' }], [{ type: 'term', text: 'OR' }]]);
  assert.deepEqual(parseQuery('OR deploy').groups, [[{ type: 'term', text: 'deploy' }]]);
  assert.deepEqual(parseQuery('say "unterminated phrase').groups, [
    [{ type: 'term', text: 'say' }],
    [{ type: 'phrase', text: 'unterminated phrase' }]
  ]);
  assert.deepEqual(parseQuery('   ').groups, []);
  assert.deepEqual(parseQuery('NOT "two words"').excluded, [{ type: 'phrase', text: 'two words' }]);
});

await test('smart mode requires every term and adds no prefix matching', () => {
  const body = buildSearchBody({ query: 'auth login', limit: 7, perSession: 3 });
  const bool = body.query.function_score.query.bool;
  assert.equal(bool.must.length, 2);
  assert.equal(JSON.stringify(bool).includes('"prefix"'), false);
  assert.equal(JSON.stringify(bool).includes('"fuzzy"'), false);
  assert.deepEqual(bool.must[0].bool.should[0], { match_phrase: { text: { query: 'auth', boost: 3 } } });
  assert.equal(bool.should[0].match_phrase.text.query, 'auth login');
  assert.equal(body.size, 7);
  assert.equal(body.collapse.field, 'session_key');
  assert.equal(body.collapse.inner_hits.size, 3);
  assert.equal(body.collapse.inner_hits.highlight.number_of_fragments, 1);
  assert.deepEqual(body.sort[0], { _score: 'desc' });
  assert.deepEqual(Object.keys(body.aggs).sort(), ['projects', 'sessions', 'sources', 'when']);
  assert.equal(buildSearchBody({ query: 'x' }).collapse.inner_hits.size, 1, 'one match per session by default');
});

await test('looser modes add prefix and fuzzy alternatives', () => {
  const prefix = JSON.stringify(buildSearchBody({ query: 'elasticsea index.js', mode: 'prefix' }));
  assert.equal(prefix.includes('{"prefix":{"text":{"value":"elasticsea"}}}'), true);
  assert.equal(prefix.includes('"value":"index.js"'), false);
  const fuzzy = JSON.stringify(buildSearchBody({ query: 'Autentication abc', mode: 'fuzzy' }));
  assert.equal(fuzzy.includes('"fuzzy":{"text":{"value":"autentication"'), true);
  assert.equal(fuzzy.includes('"fuzzy":{"text":{"value":"abc"'), false);
  const partial = buildSearchBody({ query: 'one two three', mode: 'partial' }).query.function_score.query.bool;
  assert.equal(partial.should.length, 3);
  assert.equal(partial.minimum_should_match, '70%');
  assert.equal(partial.must, undefined);
  const session = buildSearchBody({ query: 'one two', mode: 'session', sessionKeys: ['claude:x'] }).query.function_score.query.bool;
  assert.deepEqual(session.filter.at(-1), { terms: { session_key: ['claude:x'] } });
  assert.equal(session.minimum_should_match, 1);
});

await test('literal mode escapes wildcards and sorts by time', () => {
  const body = buildSearchBody({ query: 'a*b?c\\d', mode: 'literal' });
  const wildcard = body.query.bool.filter.at(-1).wildcard['text.sub'];
  assert.equal(wildcard.value, '*a\\*b\\?c\\\\d*');
  assert.equal(wildcard.case_insensitive, true);
  assert.deepEqual(Object.keys(body.sort[0]), ['timestamp']);
  assert.equal(body.collapse.inner_hits._source.includes('text'), true);
  assert.equal(body.collapse.inner_hits.highlight, undefined);
});

await test('filters map to the right clauses', () => {
  const body = buildSearchBody({
    query: 'x',
    sort: 'recent',
    filters: { source: 'codex', project: 'udx.dev', since: '2026-01-02T00:00:00Z', role: 'user' }
  });
  const filter = body.query.bool.filter;
  assert.deepEqual(filter[0], { term: { kind: 'message' } });
  assert.deepEqual(filter[1], { term: { source: 'codex' } });
  assert.equal(filter[2].bool.should[0].wildcard.project.value, '*udx.dev*');
  assert.equal(filter[2].bool.should[1].wildcard.project_encoded.case_insensitive, true);
  assert.deepEqual(filter[3], { range: { session_modified_at: { gte: '2026-01-02T00:00:00.000Z' } } });
  assert.deepEqual(filter[4], { term: { role: 'user' } });
  assert.deepEqual(filter[5], { term: { has_text: true } });
  assert.deepEqual(Object.keys(body.sort[0]), ['timestamp']);
  assert.equal(buildSearchBody({ query: 'x', filters: { source: 'all' } }).query.function_score.query.bool.filter.length, 2);
});

await test('label filters match a message or its session', () => {
  const body = buildSearchBody({
    query: 'x',
    filters: { labels: [{ key: 'client', value: 'acme' }, { key: 'topic', value: ['a', 'b'] }], labelSessionKeys: ['claude:1'] }
  });
  const clause = body.query.function_score.query.bool.filter[1];
  assert.deepEqual(clause.bool.should[0].bool.filter[0], { term: { 'labels.client': { value: 'acme', case_insensitive: true } } });
  assert.equal(clause.bool.should[0].bool.filter[1].bool.should.length, 2);
  assert.deepEqual(clause.bool.should[1], { terms: { session_key: ['claude:1'] } });
});

await test('tool search widens the fields and drops the text-only filter', () => {
  const body = buildSearchBody({ query: 'git "push origin"', includeTools: true, filters: { tool: 'Bash' } });
  const bool = body.query.function_score.query.bool;
  const serialized = JSON.stringify(bool);
  assert.equal(serialized.includes('"has_text"'), false);
  assert.equal(serialized.includes('{"match_phrase":{"tool_input":{"query":"git","boost":2}}}'), true);
  assert.equal(serialized.includes('{"match_phrase":{"tool_input":{"query":"push origin","slop":0,"boost":2}}}'), true);
  assert.deepEqual(bool.filter.at(-1), { term: { tools: { value: 'Bash', case_insensitive: true } } });
  assert.ok(body.collapse.inner_hits.highlight.fields.tool_input);
});

await test('drilling into a session lists its matches in order', () => {
  const body = buildSearchBody({ query: 'x', limit: 7, inSession: 'claude:abc' });
  assert.equal(body.size, 1);
  assert.equal(body.collapse.inner_hits.size, 7);
  assert.deepEqual(body.collapse.inner_hits.sort, [{ seq: 'asc' }]);
  assert.deepEqual(body.query.function_score.query.bool.filter.at(-1), { term: { session_key: 'claude:abc' } });
  assert.deepEqual(Object.keys(body.aggs), ['sessions']);
});

console.log('\ndocuments');

await test('tool input is flattened to values', () => {
  assert.equal(toolInputText({ command: 'git status', description: 'Show status', timeout: 120, nested: { paths: ['a.js', 'b.js'] }, flag: true, empty: '  ' }),
    'git status\nShow status\n120\na.js\nb.js');
  assert.equal(toolInputText('raw string'), 'raw string');
  assert.equal(toolInputText(null), '');
  assert.equal(toolInputText({ blob: 'x'.repeat(5000) }).length, 2000);
});

await test('collects message and session documents with stable positions', async () => {
  const messages = [
    { type: 'user', timestamp: iso(-500), message: { content: [{ type: 'text', text: '<local-command-caveat>noise</local-command-caveat>' }] } },
    { type: 'user', timestamp: iso(-400), message: { content: [{ type: 'tool_result', content: 'ignored' }] } },
    { type: 'summary', summary: 'not a message' },
    { type: 'user', timestamp: iso(-300), message: { content: [{ type: 'text', text: 'Real   prompt\nsecond line' }] } },
    { type: 'assistant', timestamp: iso(-200), message: { model: 'm1', content: [{ type: 'text', text: 'Answer' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.md' } }] } },
    { type: 'assistant', timestamp: iso(-100), message: { model: 'm1', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'y'.repeat(MAX_TEXT_CHARS + 10) }] } }
  ];
  const session = {
    sessionId: ALPHA_ID, shortId: 'aaaaaaaa', source: 'claude', project: '/workspace/alpha', projectEncoded: '-workspace-alpha',
    filePath: '/tmp/a.jsonl', size: 42, modifiedAt: new Date(now)
  };
  const reader = {
    streamSessionMessages: async (_session, callback) => { for (const message of messages) callback(message); },
    extractTextContent: content => content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    isDisplayPrompt: (_source, text) => !text.startsWith('<local-command-caveat>')
  };
  const { docs, sessionDoc, stats } = await collectSessionDocs(session, reader);
  assert.deepEqual(docs.map(entry => entry.doc.seq), [0, 2, 3, 4, 5]);
  assert.deepEqual(docs.map(entry => entry.id), [0, 2, 3, 4, 5].map(seq => `claude:${ALPHA_ID}:${seq}`));
  assert.deepEqual(docs.map(entry => entry.doc.has_text), [true, true, true, false, true]);
  assert.deepEqual(docs.map(entry => entry.doc.injected), [true, false, false, false, false]);
  assert.equal(docs[1].doc.preview, 'Real prompt second line');
  assert.deepEqual(docs[1].doc.tools, []);
  assert.deepEqual(docs[2].doc.tools, ['Read']);
  assert.equal(docs[2].doc.tool_input, '/a/b.md');
  // Absent values are explicit nulls, so a merge clears what was there.
  assert.equal(docs[3].doc.text, null);
  assert.equal(docs[3].doc.preview, null);
  assert.equal(docs[3].doc.tool_input, 'ls');
  assert.equal(docs[1].doc.tool_input, null);
  assert.equal(docs[4].doc.truncated, true);
  assert.equal(docs[1].doc.truncated, false);
  assert.equal(docs[4].doc.text.length, MAX_TEXT_CHARS);
  assert.equal(docs[4].doc.chars, MAX_TEXT_CHARS + 10);
  assert.equal(docs[4].doc.timestamp, null);
  assert.equal(docs[0].doc.session_key, `claude:${ALPHA_ID}`);
  assert.equal('labels' in docs[0].doc, false, 'sync never writes labels');
  assert.equal(stats.truncatedMessages, 1);
  assert.equal(sessionDoc.id, `claude:${ALPHA_ID}`);
  assert.equal(sessionDoc.doc.title, 'Real prompt second line');
  assert.equal(sessionDoc.doc.user_count, 3);
  assert.equal(sessionDoc.doc.assistant_count, 3);
  assert.equal(sessionDoc.doc.indexed_messages, 5);
  assert.equal(sessionDoc.doc.model, 'm1');
  assert.equal(sessionDoc.doc.session_size, 42);
});

await test('text injected under the user role is recognized', () => {
  for (const text of [
    '<task-notification>\n<task-id>x</task-id>',
    '  <system-reminder>note</system-reminder>',
    '<local-command-stdout>Set model</local-command-stdout>',
    'Caveat: The messages below were generated by the user while running local commands.',
    'This session is being continued from a previous conversation that ran out of context.',
    '[Request interrupted by user for tool use]'
  ]) assert.equal(isInjectedUserText(text), true, text);
  for (const text of ['can you fix <div> rendering?', 'x < y and y > z', 'This session is great', '<3 this', 'Deploy it']) {
    assert.equal(isInjectedUserText(text), false, text);
  }
});

await test('snapshot names round-trip to their creation time', () => {
  const date = new Date(Date.UTC(2026, 10, 15, 6, 33, 24));
  assert.equal(snapshotName('sessions', date), 'sessions-20261115-063324');
  assert.equal(snapshotDate('sessions-20261115-063324').toISOString(), '2026-11-15T06:33:24.000Z');
  assert.equal(snapshotDate('sessions-foreign'), null);
});

await test('index definition carries analyzers, enrichment namespaces, and metadata', () => {
  const definition = indexDefinition({ tool_version: '9.9.9' });
  assert.equal(definition.mappings._meta.created_by, CREATED_BY);
  assert.equal(definition.mappings._meta.schema, SCHEMA_VERSION);
  assert.equal(definition.mappings._meta.tool_version, '9.9.9');
  assert.equal(definition.mappings.dynamic, false);
  assert.equal(definition.mappings.date_detection, false);
  assert.deepEqual(definition.mappings.properties.labels, { type: 'object', dynamic: true });
  assert.deepEqual(definition.mappings.properties.notes, { type: 'object', dynamic: true });
  const templates = Object.assign({}, ...definition.mappings.dynamic_templates);
  assert.equal(templates.labels_string.mapping.type, 'keyword');
  assert.equal(templates.labels_long.mapping.type, 'keyword');
  assert.equal(templates.notes_text.mapping.type, 'text');
  assert.equal(definition.mappings.properties.text.fields.sub.type, 'wildcard');
  assert.equal(definition.mappings.properties.text.search_analyzer, 'sessions_code_search');
  assert.equal(definition.settings.analysis.analyzer.sessions_code.filter.includes('flatten_graph'), true);
  assert.equal(definition.settings.analysis.analyzer.sessions_code_search.filter.includes('flatten_graph'), false);
  assert.equal(definition.settings.analysis.tokenizer.sessions_chunks.tokenize_on_chars.includes("'"), false);
  assert.equal(definition.settings.index.number_of_replicas, 0);
});

await test('adjacent highlights inside one identifier are merged', () => {
  const fragment = `see ${HIGHLIGHT_OPEN}submission${HIGHLIGHT_CLOSE}-${HIGHLIGHT_OPEN}receipt${HIGHLIGHT_CLOSE}.${HIGHLIGHT_OPEN}json${HIGHLIGHT_CLOSE} and ${HIGHLIGHT_OPEN}other${HIGHLIGHT_CLOSE} word`;
  assert.equal(mergeHighlights(fragment), `see ${HIGHLIGHT_OPEN}submission-receipt.json${HIGHLIGHT_CLOSE} and ${HIGHLIGHT_OPEN}other${HIGHLIGHT_CLOSE} word`);
});

await test('a subagent transcript is indexed as a session that names its parent', async () => {
  const messages = [
    { type: 'user', timestamp: iso(-300), message: { content: [{ type: 'text', text: 'Check rounding in invoices.' }] } },
    { type: 'assistant', timestamp: iso(-200), message: { model: 'm1', content: [{ type: 'text', text: 'Totals round half down.' }] } }
  ];
  const reader = {
    streamSessionMessages: async (_session, callback) => { for (const message of messages) callback(message); },
    extractTextContent: content => content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    isDisplayPrompt: () => true
  };
  const agent = {
    sessionId: 'a1111111111111111', shortId: 'a1111111', source: 'claude', project: '/workspace/alpha',
    filePath: '/tmp/agent.jsonl', size: 9, modifiedAt: new Date(now),
    subagent: true, parentSessionId: ALPHA_ID, agentType: 'general-purpose', title: 'Billing audit'
  };
  const { docs, sessionDoc } = await collectSessionDocs(agent, reader);
  assert.equal(sessionDoc.doc.subagent, true);
  assert.equal(sessionDoc.doc.parent_session_id, ALPHA_ID);
  assert.equal(sessionDoc.doc.agent_type, 'general-purpose');
  assert.equal(sessionDoc.doc.title, 'Billing audit');
  // What a subagent was told came from its parent agent, so it is not "you".
  assert.deepEqual(docs.map(entry => [entry.doc.role, entry.doc.injected, entry.doc.subagent, entry.doc.parent_session_id]),
    [['user', true, true, ALPHA_ID], ['assistant', false, true, ALPHA_ID]]);

  const { subagent, parentSessionId, agentType, ...ordinary } = agent;
  const plain = await collectSessionDocs({ ...ordinary, sessionId: BETA_ID }, reader);
  assert.equal('subagent' in plain.sessionDoc.doc, false);
  assert.equal('parent_session_id' in plain.docs[0].doc, false);
  assert.equal(plain.docs[0].doc.injected, false);

  const mapping = indexDefinition().mappings.properties;
  assert.deepEqual([mapping.subagent.type, mapping.parent_session_id.type, mapping.agent_type.type], ['boolean', 'keyword', 'keyword']);
});

await test('local sessions are compared with the indexed ones', () => {
  const modifiedAt = new Date(now);
  const local = [
    { source: 'claude', sessionId: 'same', size: 10, modifiedAt },
    { source: 'claude', sessionId: 'grown', size: 20, modifiedAt },
    { source: 'codex', sessionId: 'new', size: 5, modifiedAt }
  ];
  const indexed = new Map([
    ['claude:same', { size: 10, modifiedAt: new Date(now) }],
    ['claude:grown', { size: 15, modifiedAt: new Date(now - 1000) }],
    ['kimi:gone', { size: 1, modifiedAt }]
  ]);
  assert.deepEqual(compareWithIndex(local, indexed), { changed: 1, added: 1, missing: 1, bytes: 25 });
});

await test('labels parse as key=value with optional lists', () => {
  assert.deepEqual(parseLabel('client=acme'), { key: 'client', value: 'acme' });
  assert.deepEqual(parseLabel('topic= billing, invoices ,'), { key: 'topic', value: ['billing', 'invoices'] });
  assert.deepEqual(parseLabel('url=https://x.test/a=b'), { key: 'url', value: 'https://x.test/a=b' });
  for (const bad of ['novalue=', '=x', 'bad key=1', 'a.b=1', 'plain']) assert.throws(() => parseLabel(bad), bad);
});

// --- 2. CLI against a fake Elasticsearch ---

console.log('\nCLI with a fake Elasticsearch');

const fake = createFakeElastic();
const fakeUrl = await fake.start();
const fakeEnv = { ...baseEnv, SESSIONS_ES_URL: fakeUrl };
const fakeIndex = () => {
  for (const [name, entry] of fake.state.indices) {
    if (entry.aliases.has('sessions')) return [name, entry];
  }
  return [null, null];
};
const bulkCount = () => fake.state.requests.filter(request => request.path.endsWith('/_bulk')).length;

await test('the first sync creates the index and points the alias at it', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-foreign', { meta: {} });
  seedSnapshot(fake.state, 'sessions-20180101-000000', { meta: { created_by: 'someone-else' } });
  const result = await ok(['sync'], fakeEnv);
  assert.match(result.stdout, /Indexed 4 sessions, 15 messages/);
  assert.match(result.stdout, /claude 2/);

  const [name, entry] = fakeIndex();
  assert.match(name, /^sessions-\d{8}-\d{6}$/);
  assert.equal(entry.docs.size, TOTAL_MESSAGES + TOTAL_SESSIONS);
  assert.equal(entry.meta.complete, true);
  assert.equal(entry.meta.sessions, TOTAL_SESSIONS);
  assert.equal(entry.meta.messages, TOTAL_MESSAGES);
  assert.equal(entry.meta.last_sync.mode, 'create');
  assert.deepEqual(entry.meta.last_sync.scope, { source: 'all', project: null, since: null });
  assert.deepEqual(entry.definition.mappings.properties.labels, { type: 'object', dynamic: true });
  assert.equal(fake.state.indices.has('sessions-foreign'), true, 'unrelated index kept');
  assert.equal(fake.state.indices.has('sessions-20180101-000000'), true, 'index from another tool kept');

  const bulk = fake.state.requests.find(request => request.path.endsWith('/_bulk')).body;
  assert.equal(bulk.includes('"doc_as_upsert":true'), true, 'documents are merged, not replaced');
  const toolDoc = entry.docs.get(`claude:${ALPHA_ID}:2`);
  assert.deepEqual(toolDoc.tools, ['Bash']);
  assert.equal(toolDoc.has_text, false);
  assert.equal(toolDoc.tool_input, 'git commit -m "fix login"\nCommit the fix');
  const codexSession = entry.docs.get(`codex:${CODEX_ID}`);
  assert.equal(codexSession.kind, 'session');
  assert.equal(codexSession.project, '/workspace/alpha');
  assert.equal(codexSession.message_count, 3);
  assert.equal(entry.docs.get(`kimi:${KIMI_ID}:1`).text, 'Kimi answer mentions grafana panels.');
});

await test('a sync with nothing changed re-reads nothing', async () => {
  const [before] = fakeIndex();
  fake.state.requests.length = 0;
  const result = await ok(['sync'], fakeEnv);
  assert.match(result.stdout, /Already up to date: 4 sessions unchanged/);
  assert.equal(bulkCount(), 0);
  assert.equal(fakeIndex()[0], before);
  assert.equal(fakeIndex()[1].meta.last_sync.mode, 'update');
});

await test('sync merges into documents and leaves other fields alone', async () => {
  const [, entry] = fakeIndex();
  Object.assign(entry.docs.get(`claude:${ALPHA_ID}:1`), { labels: { topic: 'auth' }, my_field: 'agent-data' });
  entry.docs.get(`claude:${ALPHA_ID}`).labels = { client: 'acme' };
  writeJsonl(alphaPath, [...alphaMessages(), claudeMessage('assistant', 'A newly appended zebracorn line.', -100, '/workspace/alpha')]);

  const result = await ok(['sync'], fakeEnv);
  assert.match(result.stdout, /Synced 1 changed session, 6 messages/);
  assert.match(result.stdout, /claude 1; 3 sessions unchanged/);
  const enriched = entry.docs.get(`claude:${ALPHA_ID}:1`);
  assert.deepEqual(enriched.labels, { topic: 'auth' });
  assert.equal(enriched.my_field, 'agent-data');
  assert.match(enriched.text, /^I traced the authentication bug/);
  assert.equal(entry.docs.get(`claude:${ALPHA_ID}:5`).text, 'A newly appended zebracorn line.');
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}`).labels, { client: 'acme' });
  assert.equal(entry.docs.get(`claude:${ALPHA_ID}`).message_count, 6);
});

await test('sync removes messages that left a rewritten transcript', async () => {
  const [, entry] = fakeIndex();
  writeJsonl(alphaPath, alphaMessages().slice(0, 2));
  const result = await ok(['sync'], fakeEnv);
  assert.match(result.stdout, /removed 4 messages no longer in their transcripts/);
  const remaining = [...entry.docs.keys()].filter(id => id.startsWith(`claude:${ALPHA_ID}:`)).sort();
  assert.deepEqual(remaining, [`claude:${ALPHA_ID}:0`, `claude:${ALPHA_ID}:1`]);
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}:1`).labels, { topic: 'auth' });
  assert.equal(entry.docs.get(`claude:${ALPHA_ID}`).message_count, 2);
});

await test('sessions whose transcript is gone stay until pruned', async () => {
  const [, entry] = fakeIndex();
  rmSync(betaPath);
  const kept = await ok(['sync'], fakeEnv);
  assert.match(kept.stdout, /1 session no longer on disk stay searchable; --prune removes them/);
  assert.equal(entry.docs.has(`claude:${BETA_ID}:0`), true);
  const pruned = await ok(['sync', '--prune'], fakeEnv);
  assert.match(pruned.stdout, /pruned 1 session no longer on disk/);
  assert.equal([...entry.docs.keys()].some(id => id.startsWith(`claude:${BETA_ID}`)), false);
  writeFixtures();
  const restored = await ok(['sync'], fakeEnv);
  assert.match(restored.stdout, /Synced 2 changed sessions, 10 messages/);
  assert.equal(entry.docs.size, TOTAL_MESSAGES + TOTAL_SESSIONS);
});

await test('a rebuild writes a new index and carries labels over', async () => {
  const [oldName, oldEntry] = fakeIndex();
  Object.assign(oldEntry.docs.get(`claude:${ALPHA_ID}:0`), { labels: { keep: 'yes' }, my_field: 'not carried' });
  oldEntry.docs.get(`claude:${ALPHA_ID}`).labels = { client: 'acme' };
  oldEntry.docs.get(`claude:${ALPHA_ID}:1`).labels = { topic: 'auth' };
  await sleep(1100);
  const summary = await json(['sync', '--rebuild'], fakeEnv);
  assert.equal(summary.mode, 'rebuild');
  assert.notEqual(summary.index, oldName);
  assert.deepEqual(summary.removed, [oldName]);
  assert.deepEqual(summary.carried, { sessions: 0, enriched: 3 });
  assert.equal(summary.sessions, TOTAL_SESSIONS);

  const [name, entry] = fakeIndex();
  assert.equal(name, summary.index);
  assert.equal(fake.state.indices.has(oldName), false);
  assert.equal(entry.docs.size, TOTAL_MESSAGES + TOTAL_SESSIONS);
  const carried = entry.docs.get(`claude:${ALPHA_ID}:0`);
  assert.deepEqual(carried.labels, { keep: 'yes' });
  assert.match(carried.text, /^Please fix the authentication bug/);
  assert.equal(carried.my_field, undefined, 'only labels and notes cross a rebuild');
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}`).labels, { client: 'acme' });
  assert.equal(entry.meta.last_sync.mode, 'rebuild');
});

await test('a scoped rebuild keeps everything outside its scope', async () => {
  const [, oldEntry] = fakeIndex();
  oldEntry.docs.get(`codex:${CODEX_ID}`).labels = { tag: 'x' };
  await sleep(1100);
  const summary = await json(['sync', '--rebuild', '--source', 'claude'], fakeEnv);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.carried.sessions, 2);
  const [, entry] = fakeIndex();
  assert.equal(entry.docs.size, TOTAL_MESSAGES + TOTAL_SESSIONS);
  assert.deepEqual(entry.docs.get(`codex:${CODEX_ID}`).labels, { tag: 'x' });
  assert.equal(entry.docs.get(`kimi:${KIMI_ID}:0`).text, 'Kimi question about dashboards.');
});

await test('an index from another format is rebuilt automatically', async () => {
  const [oldName, oldEntry] = fakeIndex();
  oldEntry.meta = { ...oldEntry.meta, schema: 0 };
  await sleep(1100);
  const result = await ok(['sync'], fakeEnv);
  assert.match(result.stdout, /Rebuilt the index from 4 sessions, 15 messages/);
  assert.match(result.stdout, /the index format changed, so it was rebuilt/);
  assert.notEqual(fakeIndex()[0], oldName);
  assert.equal(fakeIndex()[1].meta.schema, SCHEMA_VERSION);
});

await test('--index and --keep apply to a rebuild', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'custom-20200101-000000', { alias: 'custom' });
  const summary = await json(['sync', '--rebuild', '--source', 'claude', '-p', 'alpha', '--keep', '2', '--index', 'custom'], fakeEnv);
  assert.equal(summary.mode, 'rebuild');
  assert.equal(summary.sessions, 1);
  assert.equal(summary.messages, 5);
  assert.deepEqual(summary.removed, []);
  assert.equal(fake.state.indices.has('custom-20200101-000000'), true);
  assert.deepEqual([...fake.state.indices.get('custom-20200101-000000').aliases], []);
  assert.deepEqual(fake.state.indices.get(summary.index).meta.last_sync.scope, { source: 'claude', project: 'alpha', since: null });
});

await test('a rejected document keeps its session open for the next sync', async () => {
  fake.reset();
  fake.state.failBulkIds.add(`claude:${BETA_ID}:0`);
  const result = await cli(['sync'], fakeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 document failed to index; the next sync retries their sessions/);
  assert.match(result.stderr, /simulated failure/);
  const [, entry] = fakeIndex();
  assert.equal(entry.docs.has(`claude:${BETA_ID}`), false, 'no fingerprint for the incomplete session');
  assert.equal(entry.docs.has(`claude:${ALPHA_ID}`), true);
  fake.state.failBulkIds.clear();
  const retry = await ok(['sync'], fakeEnv);
  assert.match(retry.stdout, /Synced 1 changed session, 5 messages/);
  assert.equal(entry.docs.has(`claude:${BETA_ID}`), true);
});

await test('a failed first sync removes its partial index', async () => {
  fake.reset();
  fake.state.failRefresh = true;
  const result = await cli(['sync'], fakeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refresh failed/);
  assert.equal(fake.state.indices.size, 0);
});

await test('a failed update leaves the index in place', async () => {
  fake.reset();
  await ok(['sync'], fakeEnv);
  const [name] = fakeIndex();
  writeJsonl(alphaPath, [...alphaMessages(), claudeMessage('user', 'one more', -50, '/workspace/alpha')]);
  fake.state.failRefresh = true;
  const result = await cli(['sync'], fakeEnv);
  assert.equal(result.status, 1);
  assert.equal(fakeIndex()[0], name);
  writeFixtures();
});

await test('sync --dry-run needs no Elasticsearch', async () => {
  const result = await ok(['sync', '--dry-run']);
  assert.match(result.stdout, /Would index 4 sessions, 15 messages/);
});

await test('sync without a URL explains how to configure one', async () => {
  const result = await cli(['sync']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Elasticsearch is optional/);
  assert.match(result.stderr, /docker run/);
  assert.match(result.stderr, /export SESSIONS_ES_URL=http:\/\/127\.0\.0\.1:9220\n {2}sessions sync\n/);
  assert.match(result.stderr, /~\/\.sessions\/config\.yaml/);
});

await test('sync refuses a remote host unless explicitly allowed', async () => {
  const env = { ...baseEnv, SESSIONS_ES_URL: 'https://search.example.invalid:9243' };
  const refused = await cli(['sync'], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to touch https:\/\/search\.example\.invalid:9243/);
  assert.match(refused.stderr, /--allow-remote/);
  const dropRefused = await cli(['sync', '--drop'], env);
  assert.equal(dropRefused.status, 1);
  const allowed = await cli(['sync', '--allow-remote'], env);
  assert.equal(allowed.status, 1);
  assert.match(allowed.stderr, /Cannot reach Elasticsearch/);
  assert.doesNotMatch(allowed.stderr, /Refusing/);
});

await test('credentials never appear in output', async () => {
  const env = { ...baseEnv, SESSIONS_ES_URL: 'http://someuser:s3cretpw@127.0.0.1:9', SESSIONS_SEARCH_BACKEND: 'elasticsearch' };
  const sync = await cli(['sync'], env);
  const search = await cli(['search', 'needle'], env);
  for (const output of [sync.stdout, sync.stderr, search.stdout, search.stderr]) {
    assert.equal(output.includes('s3cretpw'), false);
    assert.equal(output.includes('someuser'), false);
  }
  assert.match(search.stderr, /Cannot reach Elasticsearch at http:\/\/127\.0\.0\.1:9/);
});

await test('sync rejects an invalid index name', async () => {
  const result = await cli(['sync', '--index', 'Bad Name'], fakeEnv);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid index name/);
});

await test('sync --status and --drop report on the index', async () => {
  fake.reset();
  const empty = await ok(['sync', '--status'], fakeEnv);
  assert.match(empty.stdout, /none for "sessions" yet/);
  await ok(['sync'], fakeEnv);
  const status = await json(['sync', '--status'], fakeEnv);
  assert.equal(status.index.sessions, TOTAL_SESSIONS);
  assert.equal(status.index.messages, TOTAL_MESSAGES);
  assert.equal(status.index.lastSync.mode, 'create');
  assert.deepEqual(status.index.pending, { changed: 0, added: 0, missing: 0, bytes: 0 });
  const human = await ok(['sync', '--status'], fakeEnv);
  assert.match(human.stdout, /Contents\s+15 messages in 4 sessions/);
  assert.match(human.stdout, /Since sync\s+no local changes/);
  const dropped = await json(['sync', '--drop'], fakeEnv);
  assert.equal(dropped.removed.length, 1);
  assert.equal(fake.state.indices.size, 0);
});

await test('search uses the index and renders compact highlighted hits', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  const human = await ok(['search', 'authentication bug'], fakeEnv);
  const lines = human.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '3 matches in 1 session');
  assert.match(lines[1], /^aaaaaaaa \[claude\] \/workspace\/alpha claude .* #1 \(3 matches in session\)$/);
  assert.equal(lines[2], '    I traced the authentication bug to the login flow');
  assert.equal(lines[3], '');
  assert.equal(lines[4], 'Drill in: add --session aaaaaaaa for every match in that session, or run: sessions show aaaaaaaa --around 1');
  assert.match(lines[5], /^Elasticsearch index synced .*; run "sessions sync" to include newer messages$/);
  assert.equal(lines.length, 6);
  assert.equal(human.stderr, '');

  const rows = await json(['search', 'authentication bug'], fakeEnv);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['contextMessages', 'matchMode', 'matchesInSession', 'model', 'project', 'score', 'seq', 'sessionId', 'shortId', 'snippets', 'source', 'timestamp', 'tools', 'type']);
  assert.equal(rows[0].sessionId, ALPHA_ID);
  assert.equal(rows[0].type, 'assistant');
  assert.equal(rows[0].score, 4.25);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].matchMode, 'smart');

  const searches = fake.state.requests.filter(request => request.path.endsWith('/_search'));
  assert.equal(searches.at(-1).path, '/sessions-20260101-000000/_search');
});

await test('search options reach the query', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  await ok(['search', 'needle', '-n', '4', '--per-session', '5', '--source', 'codex', '-p', 'alpha', '--role', 'user', '--sort', 'recent', '--tools', '--label', 'client=acme'], fakeEnv);
  const body = fake.state.requests.filter(request => request.path.endsWith('/_search')).at(-1).body;
  assert.equal(body.size, 4);
  assert.equal(body.collapse.inner_hits.size, 5);
  assert.deepEqual(Object.keys(body.sort[0]), ['timestamp']);
  const serialized = JSON.stringify(body.query);
  assert.equal(serialized.includes('{"term":{"source":"codex"}}'), true);
  assert.equal(serialized.includes('{"term":{"role":"user"}}'), true);
  assert.equal(serialized.includes('"value":"*alpha*"'), true);
  assert.equal(serialized.includes('tool_input'), true);
  assert.equal(serialized.includes('"labels.client"'), true);
  const badLabel = await cli(['search', 'needle', '--label', 'nonsense'], fakeEnv);
  assert.equal(badLabel.status, 1);
  assert.match(badLabel.stderr, /Expected key=value/);
});

await test('an empty strict search walks the fallback modes in order', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  const result = await ok(['search', 'alphaword betaword'], fakeEnv);
  assert.match(result.stdout, /No matches for "alphaword betaword"\./);
  assert.match(result.stdout, /Elasticsearch index synced/);
  const bodies = fake.state.requests.filter(request => request.path.endsWith('/_search')).map(request => JSON.stringify(request.body));
  // smart, prefix, literal, tool calls, session aggregation, fuzzy, partial
  assert.equal(bodies.length, 7);
  assert.equal(bodies[0].includes('"prefix"'), false);
  assert.equal(bodies[0].includes('tool_input'), false);
  assert.equal(bodies[1].includes('"prefix"'), true);
  assert.equal(bodies[2].includes('"wildcard":{"text.sub":{"value":"*alphaword betaword*"'), true);
  assert.equal(bodies[3].includes('tool_input'), true);
  assert.equal(bodies[4].includes('"group_1"'), true);
  assert.equal(bodies[5].includes('"fuzzy"'), true);
  assert.equal(bodies[6].includes('"minimum_should_match":1'), true);
});

await test('--literal sends only the substring query', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  await ok(['search', 'a OR b', '--literal'], fakeEnv);
  const bodies = fake.state.requests.filter(request => request.path.endsWith('/_search'));
  assert.equal(bodies.length, 1);
  assert.equal(JSON.stringify(bodies[0].body).includes('"value":"*a OR b*"'), true);
});

await test('--session drills into one indexed session', async () => {
  fake.reset();
  await ok(['sync'], fakeEnv);
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  const human = await ok(['search', 'authentication', '--session', 'aaaaaaaa'], fakeEnv);
  const lines = human.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '3 matches in aaaaaaaa [claude] /workspace/alpha (showing 1)');
  assert.match(lines[1], /^#1 claude /);
  assert.equal(lines[4], 'Read around a match: sessions show aaaaaaaa --around 1');
  const body = fake.state.requests.filter(request => request.path.endsWith('/_search')).at(-1).body;
  assert.deepEqual(body.collapse.inner_hits.sort, [{ seq: 'asc' }]);
  assert.equal(JSON.stringify(body.query).includes(`{"term":{"session_key":"claude:${ALPHA_ID}"}}`), true);
});

await test('search falls back to scanning files when Elasticsearch is down', async () => {
  const env = { ...baseEnv, SESSIONS_ES_URL: 'http://127.0.0.1:9' };
  const result = await ok(['search', 'authentication bug'], env);
  const lines = result.stdout.split('\n');
  // The reason is part of the results, because stderr is often thrown away.
  assert.match(lines[0], /^Cannot reach Elasticsearch at http:\/\/127\.0\.0\.1:9 .*Scanning session files instead\.$/);
  assert.equal(lines[1], '2 matches in 1 session');
  assert.equal(result.stderr, '');
  // JSON on stdout stays parseable, so there the reason goes to stderr.
  const down = await ok(['search', 'authentication bug', '--json'], env);
  assert.match(down.stderr, /Cannot reach Elasticsearch .*Scanning session files instead\./);
  const rows = JSON.parse(down.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].matchesInSession, 2);
  assert.equal(rows[0].matchMode, 'smart');
  assert.equal(rows[0].seq, 0);
  assert.equal('score' in rows[0], false);
});

await test('search falls back when nothing is indexed yet', async () => {
  fake.reset();
  const result = await ok(['search', 'pickleball'], fakeEnv);
  assert.match(result.stdout, /has no "sessions" index yet \(run "sessions sync"\)\. Scanning session files instead\./);
  assert.match(result.stdout, /^1 match in 1 session$/m);
});

await test('a forced Elasticsearch backend fails instead of falling back', async () => {
  const result = await cli(['search', 'authentication'], { ...baseEnv, SESSIONS_ES_URL: 'http://127.0.0.1:9', SESSIONS_SEARCH_BACKEND: 'elasticsearch' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot reach Elasticsearch/);
  assert.equal(result.stdout, '');
  const unconfigured = await cli(['search', 'authentication'], { ...baseEnv, SESSIONS_SEARCH_BACKEND: 'elasticsearch' });
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /No Elasticsearch URL is configured/);
});

await test('--local and the local backend never contact Elasticsearch', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  const flagged = await ok(['search', 'pickleball', '--local'], fakeEnv);
  assert.match(flagged.stdout, /^1 match in 1 session$/m);
  await ok(['search', 'pickleball'], { ...fakeEnv, SESSIONS_SEARCH_BACKEND: 'local' });
  assert.equal(fake.state.requests.length, 0);
});

await test('ELASTICSEARCH_URL alone does not enable the backend', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  const env = { ...baseEnv, ELASTICSEARCH_URL: fakeUrl };
  const result = await ok(['search', 'pickleball'], env);
  assert.match(result.stdout, /^1 match in 1 session$/m);
  const sync = await cli(['sync'], env);
  assert.equal(sync.status, 1);
  assert.equal(fake.state.requests.length, 0);
});

await test('labels are the only search option that needs the index', async () => {
  const unconfigured = await cli(['search', 'git', '--label', 'a=b']);
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /Labels are kept in the optional Elasticsearch index\. Run "sessions sync" to set one up\./);
  const down = await cli(['search', 'git', '--label', 'a=b'], { ...baseEnv, SESSIONS_ES_URL: 'http://127.0.0.1:9' });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /Cannot reach Elasticsearch/);
  fake.reset();
  const scanning = await cli(['search', 'git', '--label', 'a=b', '--local'], fakeEnv);
  assert.equal(scanning.status, 1);
  assert.match(scanning.stderr, /this search is set to scan files/);
  assert.equal(fake.state.requests.length, 0);
});

await test('--tools, --tool and --session work without an index', async () => {
  // "git commit" was only ever typed into a tool call.
  const loosened = await json(['search', 'git commit']);
  assert.equal(loosened.length, 1);
  assert.equal(loosened[0].matchMode, 'tools');
  assert.equal(loosened[0].seq, 2);
  assert.deepEqual(loosened[0].tools, ['Bash']);
  const human = await ok(['search', 'git commit']);
  assert.match(human.stdout, /No message text matches; showing tool calls/);
  const asked = await json(['search', 'git commit', '--tools']);
  assert.equal(asked[0].matchMode, 'smart');
  const byTool = await json(['search', 'login', '--tool', 'Bash']);
  assert.deepEqual(byTool.map(row => row.seq), [2]);

  const drilled = await ok(['search', 'authentication', '--session', 'aaaaaaaa']);
  const lines = drilled.stdout.trimEnd().split('\n');
  assert.equal(lines[0], '2 matches in aaaaaaaa [claude] /workspace/alpha');
  assert.match(lines[1], /^#0 you /);
  assert.match(lines[3], /^#1 claude /);
  assert.equal(lines.at(-1), 'Read around a match: sessions show aaaaaaaa --around 0');
  // The same drill-in keeps working while a configured index is down.
  const down = await ok(['search', 'authentication', '--session', 'aaaaaaaa'], { ...baseEnv, SESSIONS_ES_URL: 'http://127.0.0.1:9' });
  assert.match(down.stdout, /^2 matches in aaaaaaaa /m);
  const missing = await cli(['search', 'x', '--session', 'zzzzzzzz']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Session not found: zzzzzzzz/);
});

await test('with nothing configured, nothing mentions Elasticsearch and nothing is contacted', async () => {
  fake.reset();
  const plain = await ok(['search', 'pickleball']);
  assert.match(plain.stdout, /^1 match in 1 session$/m);
  assert.equal(plain.stderr, '');
  // The tool's own Elasticsearch wording; a transcript may well use the word.
  const backendWording = /Elasticsearch index|sessions sync|Scanning session files|Cannot reach/;
  assert.doesNotMatch(plain.stdout, backendWording);
  const scanned = await ok(['search', 'pickleball', '--local']);
  assert.equal(scanned.stdout, plain.stdout);
  // Options that shape the result do not change a single match.
  const shaped = await ok(['search', 'pickleball', '--sort', 'relevance', '--per-session', '3', '--literal']);
  assert.equal(shaped.stdout, plain.stdout);
  assert.equal(shaped.stderr, '');
  const none = await ok(['search', 'zzz-nothing-says-this']);
  assert.equal(none.stdout, 'No matches for "zzz-nothing-says-this".\n');
  assert.equal(none.stderr, '');
  for (const args of [['list'], ['projects'], ['show', 'aaaaaaaa'], ['search', 'pickleball', '--json'], ['search', 'authentication', '--session', 'aaaaaaaa'], ['search', 'git commit']]) {
    const result = await ok(args);
    assert.equal(result.stderr, '', args.join(' '));
    assert.doesNotMatch(result.stdout, backendWording, args.join(' '));
  }
  assert.equal(fake.state.requests.length, 0);
});

await test('--role filters the file-scan backend too', async () => {
  const users = await json(['search', 'authentication', '--role', 'user']);
  assert.deepEqual(users.map(row => row.type), ['user']);
  const assistants = await json(['search', 'authentication', '--role', 'assistant']);
  assert.deepEqual(assistants.map(row => row.type), ['assistant']);
  const bad = await cli(['search', 'x', '--role', 'robot']);
  assert.notEqual(bad.status, 0);
});

await test('a config file enables the backend', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'fromfile-20260101-000000', { alias: 'fromfile' });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  const file = path.join(root, 'config-cli.yaml');
  writeFileSync(file, `elasticsearch:\n  url: ${fakeUrl}\n  index: fromfile\n`);
  const env = { ...baseEnv, SESSIONS_CONFIG: file };
  const rows = await json(['search', 'authentication'], env);
  assert.equal(rows[0].matchMode, 'smart');
  assert.equal(fake.state.requests.some(request => request.path === '/fromfile-20260101-000000/_search'), true);
  writeFileSync(file, `elasticsearch:\n  url: ${fakeUrl}\n  index: fromfile\nsearch:\n  backend: local\n`);
  const contacted = fake.state.requests.length;
  const local = await json(['search', 'authentication'], env);
  assert.equal(fake.state.requests.length, contacted);
  assert.equal('score' in local[0], false);
});

await test('auto_sync refreshes a stale index before searching', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  await ok(['search', 'authentication'], fakeEnv);
  assert.equal(bulkCount(), 0, 'off unless configured');

  const auto = { ...fakeEnv, SESSIONS_ES_AUTO_SYNC: '5' };
  const first = await ok(['search', 'authentication'], auto);
  assert.equal(bulkCount() > 0, true);
  assert.equal(fakeIndex()[1].docs.size, TOTAL_MESSAGES + TOTAL_SESSIONS);
  assert.match(first.stdout, /Elasticsearch index synced just now$/m);

  fake.state.requests.length = 0;
  await ok(['search', 'authentication'], auto);
  assert.equal(bulkCount(), 0, 'fresh enough the second time');

  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions', meta: { created_by: CREATED_BY, schema: 0 } });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  await ok(['search', 'authentication'], auto);
  assert.equal(bulkCount(), 0, 'never rebuilds as a side effect of searching');
});

await test('a search leaves a large backlog to "sessions sync"', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  fake.state.searchResponse = (_body, index) => cannedHit(index);
  const tight = { ...fakeEnv, SESSIONS_ES_AUTO_SYNC: '5', SESSIONS_ES_AUTO_SYNC_MAX_MB: '0.0001' };
  const result = await ok(['search', 'authentication'], tight);
  assert.equal(bulkCount(), 0, 'nothing is indexed as a side effect');
  assert.match(result.stdout, /^Elasticsearch index synced .*; 4 sessions \(\d+(\.\d+)? (B|KB)\) not indexed yet, run "sessions sync"$/m);
  // The answer still came from the index.
  assert.match(result.stdout, /^3 matches in 1 session$/m);

  const file = path.join(root, 'config-budget.yaml');
  writeFileSync(file, 'elasticsearch:\n  url: http://127.0.0.1:1\n  auto_sync: 5\n  auto_sync_max_mb: 32\n');
  assert.equal((await loadConfig({ env: { SESSIONS_CONFIG: file } })).elasticsearch.autoSyncMaxMb, 32);
  assert.equal((await loadConfig({ env: { SESSIONS_CONFIG: file, SESSIONS_ES_AUTO_SYNC_MAX_MB: '8' } })).elasticsearch.autoSyncMaxMb, 8);
  assert.equal((await loadConfig({ env: { SESSIONS_CONFIG: path.join(root, 'absent-config.yaml') } })).elasticsearch.autoSyncMaxMb, 256);
  assert.equal((await loadConfig({ env: { SESSIONS_CONFIG: file, SESSIONS_ES_AUTO_SYNC_MAX_MB: 'lots' } })).elasticsearch.autoSyncMaxMb, 256);
});

await test('an interrupted sync keeps the sessions it finished', async () => {
  fake.reset();
  const client = createClient({ url: fakeUrl });
  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6'].map(id => ({
    source: 'claude', sessionId: id, shortId: id, project: '/workspace/many', size: 100, modifiedAt: new Date(now)
  }));
  const reader = {
    streamSessionMessages: async (session, callback) => {
      callback({ type: 'user', timestamp: iso(-100), message: { content: [{ type: 'text', text: `hello from ${session.sessionId}` }] } });
    },
    extractTextContent: content => content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    isDisplayPrompt: () => true
  };
  const everything = sessions.map(session => `claude:${session.sessionId}`);
  // The first run creates the index, so the next ones update it in place.
  await syncIndex({ client, alias: 'sessions', sessions: sessions.slice(0, 1), allSessionKeys: everything, reader });

  // Then the cluster goes away part way through a larger run.
  fake.state.bulkBudget = 5;
  await assert.rejects(syncIndex({ client, alias: 'sessions', sessions, allSessionKeys: everything, reader, checkpointSessions: 1 }), /returned 503/);
  fake.state.bulkBudget = null;
  const [, entry] = fakeIndex();
  const fingerprinted = [...entry.docs.values()].filter(doc => doc.kind === 'session').map(doc => doc.session_id).sort();
  assert.deepEqual(fingerprinted, ['s1', 's2', 's3']);

  const resumed = await syncIndex({ client, alias: 'sessions', sessions, allSessionKeys: everything, reader, checkpointSessions: 1 });
  assert.equal(resumed.unchanged, 3);
  assert.equal(resumed.sessions, 3);
  assert.equal([...entry.docs.values()].filter(doc => doc.kind === 'session').length, 6);
  assert.equal([...entry.docs.values()].filter(doc => doc.kind === 'message').length, 6);
});

await test('indexed subagent matches say whose they are', async () => {
  fake.reset();
  seedSnapshot(fake.state, 'sessions-20260101-000000', { alias: 'sessions' });
  fake.state.searchResponse = (_body, index) => {
    const canned = cannedHit(index);
    Object.assign(canned.hits.hits[0].inner_hits.messages.hits.hits[0]._source, {
      session_id: 'a1111111111111111', short_id: 'a1111111', role: 'user', injected: true,
      subagent: true, parent_session_id: ALPHA_ID
    });
    return canned;
  };
  const human = await ok(['search', 'authentication'], fakeEnv);
  assert.match(human.stdout, /^a1111111 \[claude\] \/workspace\/alpha \(subagent of aaaaaaaa\) system /m);
  const [row] = await json(['search', 'authentication'], fakeEnv);
  assert.equal(row.subagent, true);
  assert.equal(row.parentSessionId, ALPHA_ID);
  const body = fake.state.requests.filter(request => request.path.endsWith('/_search')).at(-1).body;
  assert.equal(body.collapse.inner_hits._source.includes('parent_session_id'), true);
});

await test('label sets, shows, and removes labels', async () => {
  fake.reset();
  await ok(['sync'], fakeEnv);
  const [, entry] = fakeIndex();
  const set = await ok(['label', 'aaaaaaaa', 'client=acme', 'topic=auth,login'], fakeEnv);
  assert.equal(set.stdout.trim(), 'aaaaaaaa [claude] client=acme topic=auth,login');
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}`).labels, { client: 'acme', topic: ['auth', 'login'] });
  assert.equal((await ok(['label', 'aaaaaaaa'], fakeEnv)).stdout.trim(), 'aaaaaaaa [claude] client=acme topic=auth,login');
  const removed = await json(['label', 'aaaaaaaa', '--remove', 'topic'], fakeEnv);
  assert.deepEqual(removed, { sessionId: ALPHA_ID, source: 'claude', message: null, labels: { client: 'acme' } });

  const message = await ok(['label', 'aaaaaaaa', '--message', '1', 'kind=decision'], fakeEnv);
  assert.equal(message.stdout.trim(), 'aaaaaaaa [claude] message 1 kind=decision');
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}:1`).labels, { kind: 'decision' });
  assert.equal((await ok(['label', 'bbbbbbbb'], fakeEnv)).stdout.trim(), 'bbbbbbbb [claude] (no labels)');

  // Labels are untouched by the next sync of that session.
  writeJsonl(alphaPath, [...alphaMessages(), claudeMessage('user', 'one more', -50, '/workspace/alpha')]);
  await ok(['sync'], fakeEnv);
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}`).labels, { client: 'acme' });
  assert.deepEqual(entry.docs.get(`claude:${ALPHA_ID}:1`).labels, { kind: 'decision' });
  writeFixtures();
});

await test('label reports what it cannot do', async () => {
  const missing = await cli(['label', 'zzzzzzzz', 'a=b'], fakeEnv);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Session not found: zzzzzzzz/);
  const noMessage = await cli(['label', 'aaaaaaaa', '--message', '99', 'a=b'], fakeEnv);
  assert.equal(noMessage.status, 1);
  assert.match(noMessage.stderr, /has no indexed message 99/);
  const badPair = await cli(['label', 'aaaaaaaa', 'a.b=c'], fakeEnv);
  assert.equal(badPair.status, 1);
  assert.match(badPair.stderr, /Invalid label key/);
  const unconfigured = await cli(['label', 'aaaaaaaa', 'a=b']);
  assert.equal(unconfigured.status, 1);
  assert.match(unconfigured.stderr, /Labels are kept in the optional Elasticsearch index\. Run "sessions sync" to set one up\./);
  fake.reset();
  const unindexed = await cli(['label', 'aaaaaaaa', 'a=b'], fakeEnv);
  assert.equal(unindexed.status, 1);
  assert.match(unindexed.stderr, /has no "sessions" index yet/);
});

await test('show --around opens the conversation at a position', async () => {
  const result = await ok(['show', 'aaaaaaaa', '--around', '3', '-C', '1']);
  assert.match(result.stdout, /Around #3 of aaaaaaaa/);
  assert.deepEqual(result.stdout.match(/ #\d+$/gm), [' #2', ' #3', ' #4']);
  assert.match(result.stdout, /Bash: /);
  assert.match(result.stdout, /Great, now deploy it to staging\./);
  assert.doesNotMatch(result.stdout, /I traced the authentication bug/);
  assert.match(result.stdout, /Earlier: sessions show aaaaaaaa --around 1 {3}Later: sessions show aaaaaaaa --around 5/);
  const noTools = await json(['show', 'aaaaaaaa', '--around', '3', '-C', '1', '--no-tools']);
  assert.deepEqual(noTools.map(message => message.seq), [1, 3, 4]);
  const start = await json(['show', 'aaaaaaaa', '--around', '0']);
  assert.deepEqual(start.map(message => message.seq), [0, 1, 2, 3]);
  const beyond = await cli(['show', 'aaaaaaaa', '--around', '50']);
  assert.equal(beyond.status, 1);
  assert.match(beyond.stderr, /has 5 messages; there is no #50/);
});

await fake.stop();

// --- 3. CLI against a real cluster ---

const liveUrl = process.env.SESSIONS_TEST_ES_URL;
if (!liveUrl) {
  console.log('\nlive Elasticsearch\n  \x1b[33m-\x1b[0m skipped (set SESSIONS_TEST_ES_URL to run)');
} else {
  console.log(`\nlive Elasticsearch (${liveUrl})`);
  writeFixtures();
  const alias = `sessions-test-${process.pid}`;
  const liveEnv = { ...baseEnv, SESSIONS_ES_URL: liveUrl, SESSIONS_ES_INDEX: alias, SESSIONS_SEARCH_BACKEND: 'elasticsearch' };
  // Most assertions are about which messages match, so ask for several per session.
  const search = (args, env = liveEnv) => json(['search', ...args, '--per-session', '5'], env);
  const overview = (args, env = liveEnv) => json(['search', ...args], env);
  const ids = rows => [...new Set(rows.map(row => row.sessionId))].sort();
  const listSnapshots = async () => Object.keys(await (await fetch(`${liveUrl}/${alias}-*`)).json()).sort();
  const labelsOf = async (...args) => (await json(['label', ...args], liveEnv)).labels;

  try {
    let firstIndex;
    await test('sync indexes every fixture session', async () => {
      const summary = await json(['sync'], liveEnv);
      assert.equal(summary.mode, 'create');
      assert.equal(summary.sessions, TOTAL_SESSIONS);
      assert.equal(summary.messages, TOTAL_MESSAGES);
      assert.equal(summary.failed, 0);
      assert.deepEqual(summary.bySource, { claude: 2, codex: 1, kimi: 1 });
      firstIndex = summary.index;
      const status = await json(['sync', '--status'], liveEnv);
      assert.equal(status.index.name, firstIndex);
      assert.equal(status.index.sessions, TOTAL_SESSIONS);
      assert.equal(status.index.messages, TOTAL_MESSAGES);
      assert.deepEqual(status.index.pending, { changed: 0, added: 0, missing: 0, bytes: 0 });
      assert.deepEqual(status.index.labels, []);
      const again = await json(['sync'], liveEnv);
      assert.equal(again.mode, 'update');
      assert.equal(again.sessions, 0);
      assert.equal(again.unchanged, TOTAL_SESSIONS);
      assert.equal(again.index, firstIndex);
    });

    await test('every word must appear in the same message', async () => {
      const rows = await search(['authentication bug']);
      assert.deepEqual(ids(rows), [ALPHA_ID]);
      assert.deepEqual(rows.map(row => row.type).sort(), ['assistant', 'user']);
      assert.equal(rows[0].matchMode, 'smart');
      assert.equal(rows[0].matchesInSession, 2);
      assert.equal(typeof rows[0].score, 'number');
      assert.equal(rows[0].type, 'user', 'what the user asked ranks first');
      assert.deepEqual(ids(await json(['search', 'authentication bug', '--local'], { ...liveEnv, SESSIONS_SEARCH_BACKEND: 'auto' })), [ALPHA_ID]);
    });

    await test('the overview shows one match per session and -n caps matches', async () => {
      const rows = await overview(['authentication bug']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].matchesInSession, 2);
      const broad = await overview(['the']);
      assert.equal(broad.length, ids(broad).length);
      assert.equal(broad.length, 3);
      assert.equal((await overview(['the', '-n', '2'])).length, 2);
      assert.equal((await search(['the', '-n', '2'])).length, 2);
    });

    await test('identifiers match regardless of naming style', async () => {
      for (const query of ['streamSessionMessages', 'streamsessionmessages', 'stream_session_messages', 'session messages']) {
        const rows = await search([query]);
        assert.equal(rows.length, 1, query);
        assert.equal(rows[0].matchMode, 'smart', query);
        assert.match(rows[0].snippets[0], /streamSessionMessages/, query);
      }
    });

    await test('punctuated terms match as a unit', async () => {
      const dotted = await search(['index.js']);
      assert.equal(dotted.length, 1);
      assert.equal(dotted[0].sessionId, ALPHA_ID);
      assert.equal(dotted[0].matchMode, 'smart');
      const pathRows = await search(['tools/sessions/index.js']);
      assert.equal(pathRows.length, 1);
      const loose = await search(['index js']);
      assert.deepEqual(ids(loose), [ALPHA_ID, BETA_ID].sort());
      const receipt = await search(['submission-receipt']);
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0].source, 'codex');
    });

    await test('inflections match through stemming', async () => {
      const rows = await search(['deploy']);
      assert.equal(rows.length, 2);
      assert.deepEqual(ids(rows), [ALPHA_ID]);
      assert.equal(rows[0].matchMode, 'smart');
      assert.equal(rows[0].snippets[0].includes('deploy it to staging'), true, 'exact word ranks first');
    });

    await test('phrases keep word order', async () => {
      assert.equal((await search(['"authentication bug"'])).length, 2);
      assert.equal((await search(['"bug authentication"'])).length, 0);
      assert.equal((await search(['"membership portal"'])).length, 1);
    });

    await test('OR, NOT, and grep-style patterns', async () => {
      const either = await search(['pickleball OR kubernetes']);
      assert.equal(either.length, 2);
      assert.deepEqual(ids(either), [BETA_ID]);
      assert.equal((await search(['pickleball\\|kubernetes'])).length, 2);
      assert.equal((await search(['rightsizing'])).length, 2);
      const excluded = await search(['rightsizing NOT kubernetes']);
      assert.equal(excluded.length, 1);
      assert.equal(excluded[0].type, 'assistant');
      const near = await search(['authentication.*login']);
      assert.equal(near.length, 1);
      assert.equal(near[0].type, 'user');
      assert.equal(near[0].matchMode, 'smart');
    });

    await test('a word prefix is found when no exact word matches', async () => {
      const rows = await search(['elasticsea']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].matchMode, 'prefix');
      assert.equal(rows[0].source, 'codex');
      const sha = await search(['ba7d5f5']);
      assert.equal(sha[0].matchMode, 'prefix');
      assert.match(sha[0].snippets[0], /ba7d5f58a1c/);
    });

    await test('a literal substring is found when no word matches', async () => {
      const rows = await search(['ssion-rec']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].matchMode, 'literal');
      assert.match(rows[0].snippets[0], /submission-receipt\.json/);
      assert.equal((await search(['SSION-REC', '--literal'])).length, 1);
      assert.equal((await search(['authentication bug in the', '--literal'])).length, 1);
      assert.equal((await search(['=>'])).length, 0);
    });

    await test('tool calls answer when no message text does', async () => {
      const rows = await search(['editorial-revision.md']);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].matchMode, 'tools');
      assert.deepEqual(rows[0].tools, ['exec_command']);
      assert.match(rows[0].snippets[0], /exec_command: .*editorial-revision\.md/);
      const human = await ok(['search', 'editorial-revision.md'], liveEnv);
      assert.match(human.stdout, /No message text matches; showing tool calls/);
      const asked = await search(['editorial-revision.md', '--tools']);
      assert.equal(asked[0].matchMode, 'smart');
      const bash = await search(['git commit', '--tool', 'bash']);
      assert.equal(bash.length, 1);
      assert.deepEqual(bash[0].tools, ['Bash']);
      assert.equal((await search(['git commit', '--tool', 'Read'])).length, 0);
    });

    await test('terms spread across one session are found together', async () => {
      const rows = await search(['pickleball rightsizing']);
      assert.deepEqual(ids(rows), [BETA_ID]);
      assert.equal(rows[0].matchMode, 'session');
      const human = await ok(['search', 'pickleball rightsizing'], liveEnv);
      assert.match(human.stdout, /No single message contains every term; showing sessions that contain them all\./);
      assert.match(human.stdout, /in 1 session/);
    });

    await test('typos are tolerated when nothing else matches', async () => {
      const rows = await search(['autentication']);
      assert.deepEqual(ids(rows), [ALPHA_ID]);
      assert.equal(rows[0].matchMode, 'fuzzy');
    });

    await test('most terms match when no message has them all', async () => {
      const rows = await search(['zzqqxx authentication bug']);
      assert.deepEqual(ids(rows), [ALPHA_ID]);
      assert.equal(rows[0].matchMode, 'partial');
      assert.equal((await search(['zzqqxxnotaword'])).length, 0);
    });

    await test('filters narrow results', async () => {
      assert.deepEqual((await search(['authentication', '--role', 'user'])).map(row => row.type), ['user']);
      assert.equal((await search(['pickleball', '-p', 'BETA'])).length, 1);
      assert.equal((await search(['pickleball', '-p', 'workspace-beta'])).length, 1);
      assert.equal((await search(['pickleball', '-p', 'alpha'])).length, 0);
      assert.deepEqual(ids(await search(['snapshot', '--source', 'codex'])), [CODEX_ID]);
      assert.equal((await search(['snapshot', '--source', 'claude'])).length, 0);
      assert.equal((await search(['grafana', '--source', 'kimi'])).length, 1);
      assert.equal((await search(['authentication', '--since', '2999-01-01'])).length, 0);
      assert.equal((await search(['authentication', '--days', '1'])).length, 2);
    });

    await test('context messages surround a hit', async () => {
      const [row] = await overview(['traced', '-C', '1']);
      assert.deepEqual(row.contextMessages, [
        { type: 'user', text: 'Please fix the authentication bug in the login flow.', position: 'before' }
      ]);
      assert.equal(row.seq, 1);
      const [wide] = await overview(['traced', '-C', '3']);
      assert.deepEqual(wide.contextMessages.map(message => message.position), ['before', 'after', 'after']);
    });

    await test('human output is compact: counts, one line per match, facets, next steps', async () => {
      const result = await ok(['search', 'authentication bug', '--per-session', '5'], { ...liveEnv, FORCE_COLOR: '1', NO_COLOR: undefined });
      const plain = result.stdout.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
      assert.equal(plain[0], '2 matches in 1 session');
      assert.match(plain[1], /^aaaaaaaa \[claude\] \/workspace\/alpha you .* #0 \(2 matches in session\)$/);
      assert.equal(plain[2], '    Please fix the authentication bug in the login flow.');
      assert.match(plain[3], /^aaaaaaaa \[claude\] \/workspace\/alpha claude .* #1 \(2 matches in session\)$/);
      assert.equal(plain[5], '');
      assert.equal(plain[6], 'Drill in: add --session aaaaaaaa for every match in that session, or run: sessions show aaaaaaaa --around 0');
      assert.equal(plain[7], 'Elasticsearch index synced just now');
      assert.equal(plain.length, 8);
      assert.equal(result.stdout.includes('\x1b[1m\x1b[33mauthentication'), true, 'match is painted');

      const broad = (await ok(['search', 'the', '-n', '1'], liveEnv)).stdout;
      assert.match(broad, /^\d+ matches in 3 sessions \(showing 1\)$/m);
      assert.match(broad, /^Projects: alpha 2, beta 1$/m);
      assert.match(broad, /^Sources: claude 2, codex 1$/m);
      const preview = (await ok(['search', 'authentication bug', '--preview'], liveEnv)).stdout;
      assert.match(preview, /--- session prompts ---/);
      assert.match(preview, /Great, now deploy it to staging\./);
    });

    await test('--session lists every match in one session, in order', async () => {
      const rows = await json(['search', 'authentication', '--session', 'aaaaaaaa'], liveEnv);
      assert.deepEqual(rows.map(row => row.seq), [0, 1]);
      const human = (await ok(['search', 'authentication', '--session', 'aaaaaaaa'], liveEnv)).stdout.trimEnd().split('\n');
      assert.equal(human[0], '2 matches in aaaaaaaa [claude] /workspace/alpha');
      assert.match(human[1], /^#0 you /);
      assert.match(human[3], /^#1 claude /);
      assert.equal(human[6], 'Read around a match: sessions show aaaaaaaa --around 0');
      assert.deepEqual((await json(['search', 'snapshot', '--session', `codex:${CODEX_ID}`], liveEnv)).map(row => row.seq), [0, 1]);
      const none = await ok(['search', 'pickleball', '--session', 'aaaaaaaa'], liveEnv);
      assert.match(none.stdout, /No matches for "pickleball" in aaaaaaaa\./);
      const unknown = await cli(['search', 'x', '--session', 'zzzzzzzz'], liveEnv);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /No indexed session matches "zzzzzzzz"/);
    });

    await test('a config file works against the real cluster', async () => {
      const file = path.join(root, 'config-live.yaml');
      writeFileSync(file, `elasticsearch:\n  url: ${liveUrl}\n  index: ${alias}\n`);
      const rows = await overview(['pickleball'], { ...baseEnv, SESSIONS_CONFIG: file });
      assert.equal(rows[0].matchMode, 'smart');
    });

    await test('labels classify sessions and messages and filter searches', async () => {
      assert.deepEqual(await labelsOf('aaaaaaaa', 'client=acme', 'topic=auth,login'), { client: 'acme', topic: ['auth', 'login'] });
      assert.deepEqual(await labelsOf('bbbbbbbb', 'client=other', 'priority=1'), { client: 'other', priority: '1' });
      assert.deepEqual(await labelsOf('019f00001111', '--message', '1', 'kind=decision'), { kind: 'decision' });
      assert.deepEqual(await labelsOf('aaaaaaaa'), { client: 'acme', topic: ['auth', 'login'] });
      // A label can change type without a mapping conflict.
      assert.deepEqual(await labelsOf('bbbbbbbb', 'priority=high'), { client: 'other', priority: 'high' });

      assert.deepEqual(ids(await search(['the', '--label', 'client=acme'])), [ALPHA_ID]);
      assert.deepEqual(ids(await search(['the', '--label', 'client=ACME'])), [ALPHA_ID]);
      assert.deepEqual(ids(await search(['the', '--label', 'topic=login'])), [ALPHA_ID]);
      assert.equal((await search(['the', '--label', 'client=acme', '--label', 'topic=nope'])).length, 0);
      assert.equal((await search(['snapshot'])).length, 2);
      const decisions = await search(['snapshot', '--label', 'kind=decision']);
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0].labels, { kind: 'decision' });
      const labeled = await overview(['authentication']);
      assert.deepEqual(labeled[0].sessionLabels, { client: 'acme', topic: ['auth', 'login'] });
      assert.match((await ok(['search', 'authentication'], liveEnv)).stdout, /^ {4}labels: client=acme topic=auth,login$/m);

      const summary = await json(['labels'], liveEnv);
      assert.deepEqual(summary.map(entry => entry.key), ['client', 'kind', 'priority', 'topic']);
      assert.deepEqual(summary[0].values.map(item => [item.value, item.sessions]).sort(), [['acme', 1], ['other', 1]]);
      assert.match((await ok(['labels'], liveEnv)).stdout, /^client {2}(acme|other) \(1 session\), (acme|other) \(1 session\)$/m);
      assert.deepEqual((await json(['sync', '--status'], liveEnv)).index.labels.map(entry => entry.key), ['client', 'kind', 'priority', 'topic']);
      assert.deepEqual(await labelsOf('bbbbbbbb', '--remove', 'priority'), { client: 'other' });
    });

    await test('an incremental sync updates in place and keeps labels', async () => {
      writeJsonl(alphaPath, [...alphaMessages(), claudeMessage('assistant', 'A freshly written zebracorn answer.', -100, '/workspace/alpha')]);
      assert.equal((await overview(['zebracorn'])).length, 0, 'not searchable until synced');
      {
        const { bytes, ...counts } = (await json(['sync', '--status'], liveEnv)).index.pending;
        assert.deepEqual(counts, { changed: 1, added: 0, missing: 0 });
        assert.equal(bytes > 0, true);
      }
      const summary = await json(['sync'], liveEnv);
      assert.equal(summary.mode, 'update');
      assert.equal(summary.index, firstIndex);
      assert.equal(summary.sessions, 1);
      assert.equal(summary.unchanged, 3);
      assert.equal(summary.messages, 6);
      assert.equal((await overview(['zebracorn'])).length, 1);
      assert.deepEqual(await labelsOf('aaaaaaaa'), { client: 'acme', topic: ['auth', 'login'] });
      assert.deepEqual(ids(await search(['zebracorn', '--label', 'client=acme'])), [ALPHA_ID]);
    });

    await test('messages that left a transcript leave the index', async () => {
      writeJsonl(alphaPath, alphaMessages().slice(0, 2));
      const summary = await json(['sync'], liveEnv);
      assert.equal(summary.staleRemoved, 4);
      assert.equal((await overview(['zebracorn'])).length, 0);
      assert.equal((await search(['deploy'])).length, 0);
      assert.equal((await search(['authentication bug'])).length, 2);
      const status = await json(['sync', '--status'], liveEnv);
      assert.equal(status.index.messages, TOTAL_MESSAGES - 3);
    });

    await test('a rebuild swaps in a new index and carries labels over', async () => {
      await sleep(1100);
      writeFixtures();
      const summary = await json(['sync', '--rebuild'], liveEnv);
      assert.equal(summary.mode, 'rebuild');
      assert.notEqual(summary.index, firstIndex);
      assert.deepEqual(summary.removed, [firstIndex]);
      assert.equal(summary.carried.enriched, 3);
      assert.deepEqual(await listSnapshots(), [summary.index]);
      assert.deepEqual(await labelsOf('aaaaaaaa'), { client: 'acme', topic: ['auth', 'login'] });
      assert.deepEqual(await labelsOf('019f00001111', '--message', '1'), { kind: 'decision' });
      assert.deepEqual(ids(await search(['the', '--label', 'client=acme'])), [ALPHA_ID]);
      assert.equal((await search(['deploy'])).length, 2);
      const status = await json(['sync', '--status'], liveEnv);
      assert.equal(status.index.sessions, TOTAL_SESSIONS);
      assert.equal(status.index.messages, TOTAL_MESSAGES);
    });

    await test('deleted transcripts stay searchable until pruned', async () => {
      rmSync(betaPath);
      const kept = await json(['sync'], liveEnv);
      assert.equal(kept.missing, 1);
      assert.equal(kept.pruned, 0);
      assert.equal((await overview(['pickleball'])).length, 1);
      assert.deepEqual((await json(['sync', '--status'], liveEnv)).index.pending, { changed: 0, added: 0, missing: 1, bytes: 0 });
      const pruned = await json(['sync', '--prune'], liveEnv);
      assert.equal(pruned.pruned, 1);
      assert.equal((await overview(['pickleball'])).length, 0);
      assert.equal((await json(['sync', '--status'], liveEnv)).index.sessions, TOTAL_SESSIONS - 1);
    });

    await test('auto_sync makes new messages searchable without a manual sync', async () => {
      writeFixtures();
      assert.equal((await overview(['pickleball'])).length, 0);
      const rows = await overview(['pickleball'], { ...liveEnv, SESSIONS_ES_AUTO_SYNC: '0.0001' });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sessionId, BETA_ID);
    });

    await test('--keep retains the previous index after a rebuild', async () => {
      await sleep(1100);
      const summary = await json(['sync', '--rebuild', '--keep', '2'], liveEnv);
      assert.deepEqual(summary.removed, []);
      assert.equal((await listSnapshots()).length, 2);
      const status = await json(['sync', '--status'], liveEnv);
      assert.equal(status.index.name, summary.index);
    });

    await test('--drop removes the index and search falls back', async () => {
      const dropped = await json(['sync', '--drop'], liveEnv);
      assert.equal(dropped.removed.length, 2);
      assert.deepEqual(await listSnapshots(), []);
      const result = await ok(['search', 'pickleball'], { ...liveEnv, SESSIONS_SEARCH_BACKEND: 'auto' });
      assert.match(result.stdout, /has no ".*" index yet .*Scanning session files instead\./);
      assert.match(result.stdout, /^1 match in 1 session$/m);
    });
  } finally {
    await cli(['sync', '--drop'], liveEnv);
  }
}

rmSync(root, { recursive: true, force: true });
const color = failed ? 31 : 32;
console.log(`\n\x1b[${color}m${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed ? 1 : 0);
