// Elasticsearch backend for sessions: snapshot indexing and search.
//
// Everything here talks plain REST through fetch, so the package needs no
// Elasticsearch client and stays compatible with 8.x and 9.x clusters.

import { displayUrl } from './config.js';
import {
  HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE, TOKEN_SPLIT_CHARS, MAX_TOOL_CALL_CHARS,
  toolInputText, isInjectedUserText, hasTokens, parseQuery
} from './query.js';

// The query language and the text helpers live in query.js, which the
// file-scan backend shares. They stay exported from here for existing callers.
export { HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE, toolInputText, isInjectedUserText, parseQuery };

export const CREATED_BY = '@udx/sessions';
export const SCHEMA_VERSION = 1;

// Text beyond this many characters in a single message is not indexed. It
// keeps one pasted log from dominating a bulk request or a highlight pass.
export const MAX_TEXT_CHARS = 500_000;
const MAX_TOOL_INPUT_CHARS = 12_000;
const PREVIEW_CHARS = 300;
const TITLE_CHARS = 500;
const BULK_MAX_BYTES = 4 * 1024 * 1024;
const BULK_MAX_DOCS = 1_000;
const BULK_CONCURRENCY = 4;
// How much a sync indexes before it records its progress.
const CHECKPOINT_SESSIONS = 25;
const CHECKPOINT_BYTES = 64 * 1024 * 1024;

export class ElasticError extends Error {
  constructor(message, { status = null, code = null, body = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ElasticError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// --- client ---

export function createClient({ url, apiKey = null, username = null, password = null, timeoutMs = 30_000, fetchImpl = globalThis.fetch }) {
  const base = new URL(url);
  let authorization = null;
  if (apiKey) {
    authorization = `ApiKey ${apiKey}`;
  } else if (username || base.username) {
    const user = username || decodeURIComponent(base.username);
    const pass = password || decodeURIComponent(base.password);
    authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  base.username = '';
  base.password = '';
  const root = base.toString().replace(/\/+$/, '');
  const shownUrl = displayUrl(url);

  async function request(method, pathname, { body, ndjson, query, timeout = timeoutMs, allowStatus = [] } = {}) {
    const headers = { Accept: 'application/json' };
    if (authorization) headers.Authorization = authorization;
    let payload;
    if (ndjson !== undefined) {
      headers['Content-Type'] = 'application/x-ndjson';
      payload = ndjson;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const queryString = query ? `?${new URLSearchParams(query)}` : '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    let text;
    try {
      response = await fetchImpl(`${root}${pathname}${queryString}`, { method, headers, body: payload, signal: controller.signal });
      text = await response.text();
    } catch (error) {
      const reason = error.name === 'AbortError'
        ? `no response within ${Math.round(timeout / 1000)}s`
        : error.cause?.code || error.cause?.message || error.message;
      throw new ElasticError(`Cannot reach Elasticsearch at ${shownUrl} (${reason})`, { code: 'unreachable', cause: error });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch {}
    }
    if (!response.ok && !allowStatus.includes(response.status)) {
      const detail = data?.error?.root_cause?.[0]?.reason || data?.error?.reason ||
        (typeof data?.error === 'string' ? data.error : null) || text.slice(0, 200) || response.statusText;
      throw new ElasticError(`Elasticsearch ${method} ${pathname} returned ${response.status}: ${detail}`, {
        status: response.status,
        code: data?.error?.type || null,
        body: data
      });
    }
    return { status: response.status, data };
  }

  return { request, url: shownUrl };
}

// --- index definition ---

// The analyzers are tuned for transcripts, which mix prose with identifiers,
// paths, flags, and hashes:
// - sessions_chunks splits on whitespace, brackets, and quotes but keeps
//   . - _ / : @ inside a token, so "tools/sessions/index.js" survives intact.
// - word_delimiter_graph then adds the parts (tools, sessions, index, js) and
//   camelCase humps next to the original token.
// At search time the same filter yields a token graph, which Elasticsearch
// turns into "the original token OR its parts as a phrase". That is why
// "index.js" does not match a message that merely contains "index" and "js".
export function indexDefinition(meta = {}) {
  const codeText = {
    type: 'text',
    analyzer: 'sessions_code',
    search_analyzer: 'sessions_code_search',
    index_options: 'offsets'
  };
  return {
    settings: {
      index: {
        number_of_shards: 1,
        number_of_replicas: 0,
        refresh_interval: '-1'
      },
      analysis: {
        tokenizer: {
          sessions_chunks: {
            type: 'char_group',
            tokenize_on_chars: ['whitespace', ...TOKEN_SPLIT_CHARS],
            max_token_length: 255
          }
        },
        filter: {
          sessions_parts_keep: {
            type: 'word_delimiter_graph',
            generate_word_parts: true,
            generate_number_parts: true,
            split_on_case_change: true,
            split_on_numerics: false,
            preserve_original: true,
            stem_english_possessive: true
          },
          sessions_parts: {
            type: 'word_delimiter_graph',
            generate_word_parts: true,
            generate_number_parts: true,
            split_on_case_change: true,
            split_on_numerics: false,
            preserve_original: false,
            stem_english_possessive: true
          },
          sessions_english: { type: 'stemmer', language: 'porter2' }
        },
        analyzer: {
          sessions_code: {
            type: 'custom',
            tokenizer: 'sessions_chunks',
            filter: ['sessions_parts_keep', 'flatten_graph', 'lowercase', 'asciifolding']
          },
          sessions_code_search: {
            type: 'custom',
            tokenizer: 'sessions_chunks',
            filter: ['sessions_parts_keep', 'lowercase', 'asciifolding']
          },
          sessions_stem: {
            type: 'custom',
            tokenizer: 'sessions_chunks',
            filter: ['sessions_parts', 'lowercase', 'asciifolding', 'sessions_english']
          }
        }
      }
    },
    mappings: {
      // Fields sync does not know are kept in a document but not indexed,
      // except under the two enrichment namespaces below.
      dynamic: false,
      date_detection: false,
      dynamic_templates: [
        // labels.* holds classification: every value becomes an exact keyword,
        // so a label can change type (1, then "high") without a conflict.
        ...['string', 'long', 'double', 'boolean'].map(type => ({
          [`labels_${type}`]: {
            path_match: 'labels.*',
            match_mapping_type: type,
            mapping: { type: 'keyword', ignore_above: 1024 }
          }
        })),
        // notes.* holds free text such as summaries.
        { notes_text: { path_match: 'notes.*', match_mapping_type: 'string', mapping: { ...codeText } } }
      ],
      _meta: { created_by: CREATED_BY, schema: SCHEMA_VERSION, ...meta },
      properties: {
        // Enrichment written by people, agents, or "sessions label". Sync
        // never writes these, so they survive every sync and rebuild.
        labels: { type: 'object', dynamic: true },
        notes: { type: 'object', dynamic: true },

        kind: { type: 'keyword' },
        session_key: { type: 'keyword' },
        session_id: { type: 'keyword' },
        short_id: { type: 'keyword' },
        source: { type: 'keyword' },
        project: { type: 'keyword', ignore_above: 2048 },
        project_encoded: { type: 'keyword', ignore_above: 2048 },
        archived: { type: 'boolean' },
        subagent: { type: 'boolean' },
        parent_session_id: { type: 'keyword' },
        agent_type: { type: 'keyword' },
        app: { type: 'keyword' },
        desktop_kind: { type: 'keyword' },
        named: { type: 'boolean' },
        session_modified_at: { type: 'date' },
        session_started_at: { type: 'date' },
        session_size: { type: 'long' },

        // message documents
        role: { type: 'keyword' },
        seq: { type: 'integer' },
        timestamp: { type: 'date' },
        model: { type: 'keyword' },
        has_text: { type: 'boolean' },
        injected: { type: 'boolean' },
        chars: { type: 'integer' },
        truncated: { type: 'boolean' },
        text: {
          ...codeText,
          fields: {
            stem: { type: 'text', analyzer: 'sessions_stem', index_options: 'offsets' },
            // Literal substring search, the behavior of the file-scan backend.
            sub: { type: 'wildcard' }
          }
        },
        preview: { type: 'keyword', index: false, doc_values: false },
        tools: { type: 'keyword' },
        tool_input: codeText,

        // session documents
        title: codeText,
        file_path: { type: 'keyword', index: false, doc_values: false },
        user_count: { type: 'integer' },
        assistant_count: { type: 'integer' },
        message_count: { type: 'integer' },
        indexed_messages: { type: 'integer' },
        first_timestamp: { type: 'date' },
        last_timestamp: { type: 'date' }
      }
    }
  };
}

export function snapshotName(alias, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  return `${alias}-${stamp}`;
}

// Returns the creation time encoded in a snapshot index name, or null.
export function snapshotDate(indexName) {
  const match = String(indexName).match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSnapshotOf(alias, indexName) {
  return indexName.startsWith(`${alias}-`) && snapshotDate(indexName) !== null &&
    indexName.length === alias.length + 16;
}

// --- documents ---

// Sync merges its fields into existing documents, so an absent value is
// written as an explicit null: otherwise a stale value would linger.
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'number' && value < 1e12 ? value * 1000 : value;
  const date = value instanceof Date ? value : new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// appVisible: whether this run can see the desktop app's data at all.
function sessionFields(session, appVisible = false) {
  const fields = {
    session_key: `${session.source}:${session.sessionId}`,
    session_id: session.sessionId,
    short_id: session.shortId,
    source: session.source,
    project: session.project,
    project_encoded: session.projectEncoded || session.project,
    archived: session.archived === true,
    session_modified_at: toIso(session.modifiedAt),
    session_started_at: toIso(session.startedAt),
    session_size: session.size
  };
  // A subagent transcript is indexed as a session of its own that names the
  // session it worked for. Other sessions do not carry these fields at all.
  if (session.subagent === true) {
    fields.subagent = true;
    fields.parent_session_id = session.parentSessionId || null;
    fields.agent_type = session.agentType || null;
  }
  // A session of the Claude desktop app says so, and which tab it ran in.
  // Where the app's data can be seen, any other session says null: documents
  // are merged into, so a field merely left out would keep what an earlier
  // sync wrote, and the app can stop knowing a session. Where it cannot be
  // seen, nothing is said either way: a run that cannot see the app (inside
  // a container, say) does not undo what a run that can has written.
  if (session.app || appVisible) {
    fields.app = session.app || null;
    fields.desktop_kind = session.app ? session.desktopKind || null : null;
  }
  return fields;
}

// Reads one session and returns its message documents plus a session summary
// document. `seq` counts every user and assistant message, including ones that
// produce no document, so it lines up with positions in the file-scan backend.
export async function collectSessionDocs(session, { streamSessionMessages, extractTextContent, isDisplayPrompt = () => true }, { appVisible = false } = {}) {
  const shared = sessionFields(session, appVisible);
  const docs = [];
  let seq = -1;
  let userCount = 0;
  let assistantCount = 0;
  let model = null;
  let firstPrompt = null;
  let displayPrompt = null;
  let firstTimestamp = null;
  let lastTimestamp = null;
  let textChars = 0;
  let truncatedMessages = 0;

  await streamSessionMessages(session, (data) => {
    if (data.type !== 'user' && data.type !== 'assistant') return;
    seq++;
    if (data.type === 'user') userCount++;
    else assistantCount++;

    const content = data.message?.content;
    const fullText = extractTextContent(content) || '';
    const hasText = fullText.trim().length > 0;
    const timestamp = toIso(data.timestamp);
    if (timestamp) {
      firstTimestamp ||= timestamp;
      lastTimestamp = timestamp;
    }
    if (data.type === 'assistant' && !model && data.message?.model) model = data.message.model;
    if (data.type === 'user' && hasText) {
      firstPrompt ||= fullText;
      if (!displayPrompt && isDisplayPrompt(session.source, fullText)) displayPrompt = fullText;
    }

    const tools = [];
    const toolInputs = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== 'tool_use') continue;
        if (block.name && !tools.includes(block.name)) tools.push(block.name);
        const input = toolInputText(block.input);
        if (input) toolInputs.push(input);
      }
    }
    if (!hasText && tools.length === 0) return;

    const text = fullText.length > MAX_TEXT_CHARS ? fullText.slice(0, MAX_TEXT_CHARS) : fullText;
    const truncated = text.length < fullText.length;
    if (hasText) textChars += text.length;
    if (truncated) truncatedMessages++;
    docs.push({
      id: `${shared.session_key}:${seq}`,
      doc: {
        kind: 'message',
        ...shared,
        role: data.type,
        seq,
        timestamp,
        model: data.message?.model || null,
        has_text: hasText,
        // Whatever a subagent was told came from its parent, not from the user.
        injected: data.type === 'user' && hasText && (session.subagent === true || isInjectedUserText(fullText)),
        chars: fullText.length,
        truncated,
        text: hasText ? text : null,
        preview: hasText ? oneLine(text.slice(0, PREVIEW_CHARS * 4), PREVIEW_CHARS) : null,
        tools,
        tool_input: toolInputs.join('\n\n').slice(0, MAX_TOOL_INPUT_CHARS) || null
      }
    });
  });

  // A session is known by the name it was given, in the app or with /rename.
  // Without one, what a subagent was asked to do or the prompt the session
  // began with stands in, and `named` says which it is: only a real name is
  // something a search by title should answer to. The name is the one the
  // session was found with, so that a later sync can tell whether it changed
  // without reading the transcript again.
  const name = nameOf(session);
  const title = name || session.title || displayPrompt || firstPrompt || null;
  const sessionDoc = {
    kind: 'session',
    ...shared,
    title: title ? indexTitle(title) : null,
    named: name !== null,
    model: model || null,
    user_count: userCount,
    assistant_count: assistantCount,
    message_count: userCount + assistantCount,
    indexed_messages: docs.length,
    first_timestamp: firstTimestamp,
    last_timestamp: lastTimestamp,
    file_path: session.filePath
  };

  return {
    docs,
    sessionDoc: { id: shared.session_key, doc: sessionDoc },
    stats: { messages: docs.length, textChars, truncatedMessages }
  };
}

// --- index lifecycle ---
//
// One alias (default "sessions") points at one index named
// <alias>-YYYYMMDD-HHMMSS. A normal sync updates that index in place; a
// rebuild creates a new one and swaps the alias once it is complete.

export async function clusterInfo(client) {
  const { data } = await client.request('GET', '/', { timeout: 5_000 });
  return { version: data?.version?.number || 'unknown', name: data?.cluster_name || null };
}

// Lists the indices this tool created for an alias, newest first.
export async function listSnapshots(client, alias) {
  const { data } = await client.request('GET', `/${alias}-*`, {
    query: { filter_path: '*.aliases,*.mappings._meta', expand_wildcards: 'open,closed', ignore_unavailable: 'true' },
    allowStatus: [404]
  });
  const snapshots = [];
  for (const [index, body] of Object.entries(data || {})) {
    if (!isSnapshotOf(alias, index)) continue;
    const meta = body?.mappings?._meta || {};
    if (meta.created_by !== CREATED_BY) continue;
    snapshots.push({ index, meta, current: Boolean(body?.aliases && alias in body.aliases) });
  }
  return snapshots.sort((a, b) => b.index.localeCompare(a.index));
}

// Resolves the alias to its live index, or null when nothing is synced yet.
// One request returns both the index name and its metadata.
export async function currentSnapshot(client, alias) {
  const { status, data } = await client.request('GET', `/${alias}/_mapping`, {
    query: { filter_path: '*.mappings._meta' },
    timeout: 5_000,
    allowStatus: [404]
  });
  if (status === 404 || !data) return null;
  const indices = Object.keys(data)
    .filter(index => isSnapshotOf(alias, index) && data[index]?.mappings?._meta?.created_by === CREATED_BY)
    .sort();
  if (indices.length === 0) return null;
  const index = indices[indices.length - 1];
  const meta = data[index].mappings._meta;
  const createdAt = snapshotDate(index);
  const syncedAt = meta.last_sync?.at ? new Date(meta.last_sync.at) : createdAt;
  return { index, createdAt, syncedAt, meta };
}

export async function countKinds(client, index) {
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: { size: 0, track_total_hits: false, aggs: { kinds: { terms: { field: 'kind', size: 10 } } } }
  });
  const counts = { sessions: 0, messages: 0 };
  for (const bucket of data?.aggregations?.kinds?.buckets || []) {
    if (bucket.key === 'session') counts.sessions = bucket.doc_count;
    if (bucket.key === 'message') counts.messages = bucket.doc_count;
  }
  return counts;
}

export async function snapshotDetails(client, alias) {
  const current = await currentSnapshot(client, alias);
  if (!current) return null;
  const [stats, counts] = await Promise.all([
    client.request('GET', `/${current.index}/_stats/store`, { query: { filter_path: '_all.primaries' } }),
    countKinds(client, current.index)
  ]);
  return {
    ...current,
    ...counts,
    storeBytes: stats.data?._all?.primaries?.store?.size_in_bytes || 0
  };
}

// Returns Map(session_key -> { modifiedAt, size }): the state of each
// transcript when it was last indexed.
export async function indexedSessions(client, index) {
  const sessions = new Map();
  let searchAfter;
  for (;;) {
    const body = {
      size: 1000,
      query: { term: { kind: 'session' } },
      sort: [{ session_key: 'asc' }],
      _source: ['session_key', 'session_modified_at', 'session_size', 'title', 'named', 'app', 'desktop_kind']
    };
    if (searchAfter) body.search_after = searchAfter;
    const { data } = await client.request('POST', `/${index}/_search`, { body });
    const hits = data?.hits?.hits || [];
    for (const hit of hits) {
      const source = hit._source || {};
      sessions.set(source.session_key, {
        modifiedAt: source.session_modified_at ? new Date(source.session_modified_at) : null,
        size: source.session_size ?? null,
        title: source.title ?? null,
        named: source.named === true,
        app: source.app ?? null,
        desktopKind: source.desktop_kind ?? null
      });
    }
    if (hits.length < 1000) break;
    searchAfter = hits[hits.length - 1].sort;
  }
  return sessions;
}

const keyOf = session => `${session.source}:${session.sessionId}`;

// The title as it is stored: one line, cut to a sane length.
function indexTitle(title) {
  return oneLine(String(title).slice(0, TITLE_CHARS * 4), TITLE_CHARS);
}

// The name a session was found with, as the index stores it, or null.
function nameOf(session) {
  return session.named === true && typeof session.title === 'string' && session.title.trim()
    ? indexTitle(session.title)
    : null;
}

// A session is up to date when its transcript has not changed and the index
// holds what is known about it from outside the transcript: its name, and
// whether it is a session of the desktop app. Those can change without the
// transcript being touched (a session renamed in the app, a record the app
// added or removed), in either direction. An entry written before names were
// kept compares as unnamed, so only sessions that have a name are read again.
// What the app knows is compared only by a run that can see the app's data
// (appVisible), or about a session it sees the app knows: otherwise two runs
// that share an index, one of them blind to the app, would undo each other.
function sameFingerprint(entry, session, appVisible = false) {
  if (entry.size !== session.size || entry.modifiedAt === null ||
    entry.modifiedAt.getTime() !== session.modifiedAt.getTime()) return false;
  if ((entry.named === true ? entry.title : null) !== nameOf(session)) return false;
  const app = session.app || null;
  if (!app && !appVisible) return true;
  return (entry.app || null) === app && (entry.desktopKind || null) === (app ? session.desktopKind || null : null);
}

function chunked(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

// The local sessions a sync would read: new ones, and ones that changed since
// they were indexed. They keep the order they were given in.
export function pendingSessions(localSessions, indexed, { appVisible = false } = {}) {
  return localSessions.filter((session) => {
    const entry = indexed.get(keyOf(session));
    return !entry || !sameFingerprint(entry, session, appVisible);
  });
}

// Compares local sessions with an index: what the next sync would write, and
// which indexed sessions no longer have a transcript on disk.
// `bytes` is the size on disk of the transcripts a sync would read.
export function compareWithIndex(localSessions, indexed, { appVisible = false } = {}) {
  let changed = 0;
  let added = 0;
  let bytes = 0;
  const seen = new Set();
  for (const session of localSessions) {
    const key = keyOf(session);
    seen.add(key);
    const entry = indexed.get(key);
    if (entry && sameFingerprint(entry, session, appVisible)) continue;
    if (!entry) added++;
    else changed++;
    bytes += session.size || 0;
  }
  let missing = 0;
  for (const key of indexed.keys()) {
    if (!seen.has(key)) missing++;
  }
  return { changed, added, missing, bytes };
}

async function messageIds(client, index, sessionKey) {
  const ids = [];
  let searchAfter;
  for (;;) {
    const body = {
      size: 5000,
      _source: false,
      query: { bool: { filter: [{ term: { kind: 'message' } }, { term: { session_key: sessionKey } }] } },
      sort: [{ seq: 'asc' }]
    };
    if (searchAfter) body.search_after = searchAfter;
    const { data } = await client.request('POST', `/${index}/_search`, { body });
    const hits = data?.hits?.hits || [];
    for (const hit of hits) ids.push(hit._id);
    if (hits.length < 5000) break;
    searchAfter = hits[hits.length - 1].sort;
  }
  return ids;
}

// Buffers bulk actions and keeps a few requests in flight: reading
// transcripts is CPU-bound here while indexing is CPU-bound in Elasticsearch.
function createBulkWriter(client, index, { dryRun }) {
  let lines = [];
  let bytes = 0;
  let actions = 0;
  const inFlight = new Set();
  let bulkError = null;
  const failures = { count: 0, samples: [], ids: new Set() };

  const send = async (batch) => {
    const { data } = await client.request('POST', `/${index}/_bulk`, {
      ndjson: `${batch.join('\n')}\n`,
      query: { filter_path: 'errors,items.*.status,items.*.error.type,items.*.error.reason,items.*._id' },
      timeout: 120_000
    });
    if (!data?.errors) return;
    for (const item of data.items || []) {
      const result = item.update || item.delete || item.index;
      if (!result?.error) continue;
      failures.count++;
      failures.ids.add(result._id);
      if (failures.samples.length < 3) {
        failures.samples.push(`${result._id}: ${result.error.type}: ${String(result.error.reason || '').slice(0, 160)}`);
      }
    }
  };

  const flush = async () => {
    if (lines.length === 0) return;
    const batch = lines;
    lines = [];
    bytes = 0;
    actions = 0;
    if (dryRun) return;
    if (bulkError) throw bulkError;
    while (inFlight.size >= BULK_CONCURRENCY) await Promise.race(inFlight);
    const task = send(batch)
      .catch((error) => { bulkError ||= error; })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  };

  const push = async (...entries) => {
    for (const entry of entries) {
      lines.push(entry);
      bytes += entry.length + 1;
    }
    actions++;
    if (bytes >= BULK_MAX_BYTES || actions >= BULK_MAX_DOCS) await flush();
  };

  return {
    failures,
    // A partial update: sync's fields are merged into the document, and
    // whatever else it holds (labels, notes, an agent's own fields) stays.
    upsert: (id, doc) => push(JSON.stringify({ update: { _id: id } }), JSON.stringify({ doc, doc_as_upsert: true })),
    remove: id => push(JSON.stringify({ delete: { _id: id } })),
    drain: async () => {
      await flush();
      await Promise.all(inFlight);
      if (bulkError) throw bulkError;
    },
    settle: () => Promise.allSettled(inFlight)
  };
}

async function reindex(client, body) {
  const { data } = await client.request('POST', '/_reindex', {
    query: { wait_for_completion: 'true', refresh: 'false' },
    body,
    timeout: 900_000
  });
  if (data?.failures?.length) {
    throw new ElasticError(`Elasticsearch could not copy documents into the new index: ${JSON.stringify(data.failures[0]).slice(0, 200)}`);
  }
  return data?.total || 0;
}

// Brings forward what a rebuild must not lose: sessions this run will not
// re-read are copied whole, and for the rest the labels and notes are copied
// so the fresh documents merge into them.
async function carryOver(client, from, to, { verbatim, reread }) {
  const carried = { sessions: verbatim.length, enriched: 0 };
  for (const keys of chunked(verbatim, 5000)) {
    await reindex(client, {
      source: { index: from, query: { terms: { session_key: keys } } },
      dest: { index: to }
    });
  }
  for (const keys of chunked(reread, 5000)) {
    carried.enriched += await reindex(client, {
      source: {
        index: from,
        _source: ['labels', 'notes'],
        query: {
          bool: {
            filter: [{ terms: { session_key: keys } }],
            should: [{ exists: { field: 'labels' } }, { exists: { field: 'notes' } }],
            minimum_should_match: 1
          }
        }
      },
      dest: { index: to }
    });
  }
  return carried;
}

async function deleteByQuery(client, index, query) {
  const { data } = await client.request('POST', `/${index}/_delete_by_query`, {
    query: { conflicts: 'proceed', refresh: 'true' },
    body: { query },
    timeout: 300_000
  });
  return data?.deleted || 0;
}

// Brings the index up to date with the given sessions.
//
// Normally only sessions whose transcript changed are re-read, and their
// fields are merged into the existing documents. A rebuild (first run, schema
// change, or on request) writes a new index and swaps the alias when done;
// searches use the old one until then, and a failed rebuild leaves it alone.
//
// sessions:       the sessions in scope for this run
// allSessionKeys: every session on disk, used to tell "out of scope" from
//                 "transcript deleted" (defaults to the sessions in scope)
// left: { sessions, bytes } that the caller chose not to read this time. It is
//       kept with the sync's record, so whoever asks later is still told.
// appVisible: this run can see the desktop app's data (see sameFingerprint)
export async function syncIndex({
  client,
  alias,
  keep = 1,
  sessions,
  allSessionKeys = null,
  reader,
  scope = {},
  toolVersion = null,
  rebuild = false,
  prune = false,
  dryRun = false,
  left = null,
  appVisible = false,
  now = new Date(),
  onProgress = () => {},
  checkpointSessions = CHECKPOINT_SESSIONS,
  checkpointBytes = CHECKPOINT_BYTES
}) {
  const started = Date.now();
  const totals = {
    index: null,
    mode: 'dry-run',
    reason: null,
    scanned: sessions.length,
    sessions: 0,
    subagents: 0,
    unchanged: 0,
    messages: 0,
    textChars: 0,
    truncatedMessages: 0,
    bySource: {},
    unreadable: [],
    failed: 0,
    failureSamples: [],
    staleRemoved: 0,
    missing: 0,
    pruned: 0,
    carried: { sessions: 0, enriched: 0 },
    removed: [],
    dryRun
  };

  let current = null;
  let fingerprints = new Map();
  if (!dryRun) {
    current = await currentSnapshot(client, alias);
    if (current) fingerprints = await indexedSessions(client, current.index);
  }
  const schemaChanged = Boolean(current) && current.meta?.schema !== SCHEMA_VERSION;
  const fresh = !current || rebuild || schemaChanged;
  const index = fresh ? snapshotName(alias, now) : current.index;
  totals.index = index;
  if (!dryRun) {
    totals.mode = !current ? 'create' : fresh ? 'rebuild' : 'update';
    if (schemaChanged && !rebuild) totals.reason = 'schema';
  }

  const inScope = new Set(sessions.map(keyOf));
  const onDisk = allSessionKeys ? new Set(allSessionKeys) : inScope;
  const missingKeys = [...fingerprints.keys()].filter(key => !onDisk.has(key));
  totals.missing = missingKeys.length;

  if (!dryRun && fresh) {
    await client.request('PUT', `/${index}`, {
      body: indexDefinition({ tool_version: toolVersion, created_at: now.toISOString(), complete: false })
    });
  }

  const writer = createBulkWriter(client, index, { dryRun });
  try {
    if (!dryRun && fresh && current) {
      const verbatim = [...fingerprints.keys()].filter(key => !inScope.has(key) && !(prune && !onDisk.has(key)));
      totals.carried = await carryOver(client, current.index, index, { verbatim, reread: [...inScope] });
      if (prune) totals.pruned = missingKeys.length;
    }

    // Session documents carry the fingerprint that marks a transcript as
    // indexed, so each is written only after all of its messages made it.
    // That happens at a checkpoint every so often rather than once at the
    // end, so a sync that is interrupted keeps the sessions it finished and
    // the next one carries on from there.
    let sessionDocs = [];
    let sinceCheckpoint = 0;
    const checkpoint = async () => {
      await writer.drain();
      const incomplete = new Set([...writer.failures.ids].map(id => id.slice(0, id.lastIndexOf(':'))));
      for (const entry of sessionDocs) {
        if (!incomplete.has(entry.id)) await writer.upsert(entry.id, entry.doc);
      }
      sessionDocs = [];
      sinceCheckpoint = 0;
      await writer.drain();
    };

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      const key = keyOf(session);
      const previous = fingerprints.get(key);
      if (!fresh && previous && sameFingerprint(previous, session, appVisible)) {
        totals.unchanged++;
        onProgress({ done: i + 1, total: sessions.length, messages: totals.messages });
        continue;
      }

      let collected;
      try {
        collected = await collectSessionDocs(session, reader, { appVisible });
      } catch (error) {
        totals.unreadable.push(`${key}: ${error.message}`);
        continue;
      }
      for (const entry of collected.docs) await writer.upsert(entry.id, entry.doc);

      // A transcript that was rewritten can have fewer messages than before.
      if (!dryRun && !fresh && previous) {
        const kept = new Set(collected.docs.map(entry => entry.id));
        for (const id of await messageIds(client, index, key)) {
          if (kept.has(id)) continue;
          await writer.remove(id);
          totals.staleRemoved++;
        }
      }

      sessionDocs.push(collected.sessionDoc);
      sinceCheckpoint += session.size || 0;
      if (sessionDocs.length >= checkpointSessions || sinceCheckpoint >= checkpointBytes) await checkpoint();
      totals.sessions++;
      if (session.subagent === true) totals.subagents++;
      totals.messages += collected.stats.messages;
      totals.textChars += collected.stats.textChars;
      totals.truncatedMessages += collected.stats.truncatedMessages;
      totals.bySource[session.source] = (totals.bySource[session.source] || 0) + 1;
      onProgress({ done: i + 1, total: sessions.length, messages: totals.messages });
    }
    // Anything whose messages did not all make it gets no fingerprint here,
    // and is picked up again by the next sync.
    await checkpoint();
    totals.failed = writer.failures.count;
    totals.failureSamples = writer.failures.samples;

    if (!dryRun) {
      if (!fresh && prune && missingKeys.length > 0) {
        for (const keys of chunked(missingKeys, 5000)) {
          await deleteByQuery(client, index, { terms: { session_key: keys } });
        }
        totals.pruned = missingKeys.length;
      }
      if (fresh) {
        await client.request('PUT', `/${index}/_settings`, { body: { index: { refresh_interval: '1s' } } });
      }
      await client.request('POST', `/${index}/_refresh`, { timeout: 120_000 });
      if (fresh && current) {
        // Labels carried over for messages that no longer exist.
        await deleteByQuery(client, index, { bool: { must_not: { exists: { field: 'kind' } } } });
      }

      const counts = await countKinds(client, index);
      await client.request('PUT', `/${index}/_mapping`, {
        body: {
          _meta: {
            ...(fresh ? {} : current.meta),
            created_by: CREATED_BY,
            schema: SCHEMA_VERSION,
            tool_version: toolVersion,
            created_at: fresh ? now.toISOString() : current.meta?.created_at || null,
            complete: true,
            sessions: counts.sessions,
            messages: counts.messages,
            last_sync: {
              at: new Date().toISOString(),
              mode: totals.mode,
              scope,
              scanned: totals.scanned,
              updated: totals.sessions,
              unchanged: totals.unchanged,
              ...(left && left.sessions > 0 ? { left: { sessions: left.sessions, bytes: left.bytes } } : {})
            }
          }
        }
      });

      if (fresh) {
        const existing = await listSnapshots(client, alias);
        const actions = existing
          .filter(snapshot => snapshot.current && snapshot.index !== index)
          .map(snapshot => ({ remove: { index: snapshot.index, alias } }));
        actions.push({ add: { index, alias } });
        await client.request('POST', '/_aliases', { body: { actions } });

        const stale = existing
          .filter(snapshot => snapshot.index !== index)
          .slice(Math.max(0, keep - 1));
        for (const snapshot of stale) {
          await client.request('DELETE', `/${snapshot.index}`, { allowStatus: [404] });
          totals.removed.push(snapshot.index);
        }
      }
    }
  } catch (error) {
    if (!dryRun && fresh) {
      // Let in-flight requests settle first: a late bulk would otherwise
      // recreate the index we are about to remove.
      await writer.settle();
      await client.request('DELETE', `/${index}`, { allowStatus: [404] }).catch(() => {});
    }
    throw error;
  }

  totals.durationMs = Date.now() - started;
  return totals;
}

export async function dropSnapshots(client, alias) {
  const snapshots = await listSnapshots(client, alias);
  for (const snapshot of snapshots) {
    await client.request('DELETE', `/${snapshot.index}`, { allowStatus: [404] });
  }
  return snapshots.map(snapshot => snapshot.index);
}

// --- labels ---
//
// labels.* is the classification namespace: free-form keys with exact values,
// written by "sessions label", by agents, or straight through the REST API.
// Sync never touches it. A label on a session document applies to the whole
// session; a label on a message document applies to that message.

const LABEL_KEY = /^[A-Za-z0-9_-]{1,64}$/;

// Parses "key=value" or "key=a,b" into { key, value }.
export function parseLabel(pair) {
  const text = String(pair);
  const at = text.indexOf('=');
  if (at <= 0) throw new Error(`Expected key=value, got "${text}"`);
  const key = text.slice(0, at).trim();
  if (!LABEL_KEY.test(key)) throw new Error(`Invalid label key "${key}": use letters, digits, "_" or "-"`);
  const values = text.slice(at + 1).split(',').map(value => value.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`Label "${key}" needs a value`);
  return { key, value: values.length > 1 ? values : values[0] };
}

export function isValidLabelKey(key) {
  return LABEL_KEY.test(String(key));
}

// Sets and removes labels on one document. Returns its labels afterwards, or
// null when the document is not in the index.
export async function updateLabels(client, index, id, { set = {}, remove = [] } = {}) {
  const { status, data } = await client.request('POST', `/${index}/_update/${encodeURIComponent(id)}`, {
    query: { refresh: 'true', _source: 'labels' },
    body: {
      script: {
        lang: 'painless',
        source: [
          'if (ctx._source.labels == null) { ctx._source.labels = new HashMap(); }',
          'for (def entry : params.set.entrySet()) { ctx._source.labels.put(entry.getKey(), entry.getValue()); }',
          'for (def key : params.remove) { ctx._source.labels.remove(key); }',
          'if (ctx._source.labels.isEmpty()) { ctx._source.remove("labels"); }'
        ].join(' '),
        params: { set, remove }
      }
    },
    allowStatus: [404]
  });
  if (status === 404) return null;
  return data?.get?._source?.labels || {};
}

// Returns one document's labels ({} when it has none), or null when the
// document is not in the index.
export async function readLabels(client, index, id) {
  const { status, data } = await client.request('GET', `/${index}/_source/${encodeURIComponent(id)}`, {
    query: { _source_includes: 'labels' },
    allowStatus: [404]
  });
  if (status === 404) return null;
  return data?.labels || {};
}

// Returns Map(document id -> labels) for the documents that have any.
export async function getLabels(client, index, ids) {
  const labels = new Map();
  if (ids.length === 0) return labels;
  const { data } = await client.request('POST', `/${index}/_mget`, {
    query: { _source_includes: 'labels' },
    body: { ids }
  });
  for (const doc of data?.docs || []) {
    const found = doc.found ? doc._source?.labels : null;
    if (found && Object.keys(found).length > 0) labels.set(doc._id, found);
  }
  return labels;
}

// Lists every label key with its values and how many sessions carry each.
export async function labelSummary(client, index) {
  const { data } = await client.request('GET', `/${index}/_mapping/field/labels.*`);
  const fields = Object.keys(Object.values(data || {})[0]?.mappings || {})
    .filter(name => name.startsWith('labels.'))
    .sort()
    .slice(0, 100);
  if (fields.length === 0) return [];
  const aggs = {};
  fields.forEach((field, position) => {
    aggs[`label_${position}`] = {
      terms: { field, size: 50 },
      aggs: { sessions: { cardinality: { field: 'session_key' } } }
    };
  });
  const { data: result } = await client.request('POST', `/${index}/_search`, {
    body: { size: 0, track_total_hits: false, aggs }
  });
  return fields
    .map((field, position) => ({
      key: field.slice('labels.'.length),
      values: (result?.aggregations?.[`label_${position}`]?.buckets || []).map(bucket => ({
        value: bucket.key,
        sessions: bucket.sessions?.value ?? 0,
        documents: bucket.doc_count
      }))
    }))
    .filter(entry => entry.values.length > 0);
}

function labelClause({ key, value }) {
  const values = Array.isArray(value) ? value : [value];
  const terms = values.map(item => ({ term: { [`labels.${key}`]: { value: String(item), case_insensitive: true } } }));
  return terms.length === 1 ? terms[0] : { bool: { should: terms, minimum_should_match: 1 } };
}

// Returns the keys of the sessions whose own labels satisfy every filter.
export async function sessionKeysWithLabels(client, index, labels) {
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: {
      size: 10_000,
      _source: false,
      query: { bool: { filter: [{ term: { kind: 'session' } }, ...labels.map(labelClause)] } }
    }
  });
  return (data?.hits?.hits || []).map(hit => hit._id);
}

// --- query language ---

function isPlainWord(text, minLength = 3) {
  return new RegExp(`^[\\p{L}\\p{N}]{${minLength},}$`, 'u').test(text);
}

// options.prefix also accepts words that start with a plain term;
// options.fuzzy also accepts words within a typo of it.
function itemClause(item, { includeTools = false, prefix = false, fuzzy = false } = {}) {
  const should = [];
  if (item.type === 'phrase' || item.type === 'near') {
    // "near" comes from a grep-style a.*b: the words in order, not adjacent.
    const slop = item.type === 'near' ? 40 : 0;
    should.push({ match_phrase: { text: { query: item.text, slop, boost: 3 } } });
    if (item.type === 'near') should.push({ match_phrase: { 'text.stem': { query: item.text, slop, boost: 1.5 } } });
    if (includeTools) should.push({ match_phrase: { tool_input: { query: item.text, slop, boost: 2 } } });
    return { bool: { should, minimum_should_match: 1 } };
  }

  // match_phrase keeps the parts of a punctuated term adjacent: "index.js"
  // must appear as index followed by js, not as two unrelated words.
  should.push({ match_phrase: { text: { query: item.text, boost: 3 } } });
  should.push({ match_phrase: { 'text.stem': { query: item.text, boost: 1.5 } } });
  if (includeTools) should.push({ match_phrase: { tool_input: { query: item.text, boost: 2 } } });
  const value = item.text.toLowerCase();
  if (prefix && isPlainWord(item.text)) {
    should.push({ prefix: { text: { value } } });
    if (includeTools) should.push({ prefix: { tool_input: { value } } });
  }
  if (fuzzy && isPlainWord(item.text, 4)) {
    should.push({ fuzzy: { text: { value, fuzziness: 'AUTO', prefix_length: 1, boost: 0.5 } } });
  }
  return { bool: { should, minimum_should_match: 1 } };
}

function groupClause(group, options) {
  if (group.length === 1) return itemClause(group[0], options);
  return { bool: { should: group.map(item => itemClause(item, options)), minimum_should_match: 1 } };
}

// The text a literal-substring fallback should look for, or null when the
// query uses operators that have no literal reading.
function literalText(query, parsed) {
  if (parsed.excluded.length > 0 || parsed.groups.some(group => group.length > 1)) return null;
  if (parsed.groups.some(group => group[0].type === 'near')) return null;
  if (parsed.groups.length === 1) return parsed.groups[0][0].text;
  if (parsed.groups.every(group => group[0].type === 'term')) return String(query).trim().replace(/\s+/g, ' ');
  return null;
}

function escapeWildcard(value) {
  return String(value).replace(/[\\*?]/g, '\\$&');
}

// labels: [{ key, value }] that a message must satisfy, either through its
// own labels or through its session's (labelSessionKeys lists those sessions).
export function buildFilters({ source, project, since, role, tool, includeTools, labels, labelSessionKeys } = {}) {
  const filter = [{ term: { kind: 'message' } }];
  if (labels && labels.length > 0) {
    filter.push({
      bool: {
        should: [
          { bool: { filter: labels.map(labelClause) } },
          { terms: { session_key: labelSessionKeys || [] } }
        ],
        minimum_should_match: 1
      }
    });
  }
  if (source && source !== 'all') filter.push({ term: { source } });
  if (project) {
    const value = `*${escapeWildcard(project)}*`;
    filter.push({
      bool: {
        should: [
          { wildcard: { project: { value, case_insensitive: true } } },
          { wildcard: { project_encoded: { value, case_insensitive: true } } }
        ],
        minimum_should_match: 1
      }
    });
  }
  if (since) filter.push({ range: { session_modified_at: { gte: new Date(since).toISOString() } } });
  if (role) filter.push({ term: { role } });
  if (tool) filter.push({ term: { tools: { value: tool, case_insensitive: true } } });
  if (!includeTools && !tool) filter.push({ term: { has_text: true } });
  return filter;
}

const HIT_SOURCE = ['session_key', 'session_id', 'short_id', 'source', 'project', 'role', 'seq', 'timestamp', 'model', 'tools', 'has_text', 'injected', 'preview', 'labels', 'subagent', 'parent_session_id', 'app', 'desktop_kind'];

// The match modes, from strictest to loosest. A search walks down this list
// until one of them finds something (see searchSnapshot).
//   smart    every term in one message: exact words, inflections, identifier parts
//   prefix   same, and a plain word also matches words that start with it
//   literal  the query as a case-insensitive substring (the file-scan behavior)
//   tools    every term in one tool call: a command, a path, an argument
//   session  every term somewhere in the same session, in different messages
//   fuzzy    every term in one message, allowing a typo per word
//   partial  most of the terms in one message
export const MATCH_MODES = ['smart', 'prefix', 'literal', 'tools', 'session', 'fuzzy', 'partial'];

const sessionCount = { sessions: { cardinality: { field: 'session_key', precision_threshold: 10_000 } } };

// Where and when the matches are, counted in sessions: the way to see the
// shape of a large result and pick a filter to narrow it.
const FACETS = {
  projects: { terms: { field: 'project', size: 5, order: { sessions: 'desc' } }, aggs: sessionCount },
  sources: { terms: { field: 'source', size: 5, order: { sessions: 'desc' } }, aggs: sessionCount },
  when: {
    date_range: {
      field: 'timestamp',
      keyed: false,
      ranges: [
        { key: 'past day', from: 'now-1d' },
        { key: 'past week', from: 'now-7d', to: 'now-1d' },
        { key: 'past month', from: 'now-30d', to: 'now-7d' },
        { key: 'older', to: 'now-30d' }
      ]
    },
    aggs: sessionCount
  }
};

// sort: 'relevance' or 'recent'.
// limit: sessions to return; perSession: matches to return for each.
// sessionKeys restricts the 'session' mode to the sessions already known to
// contain every term. inSession drills into one session: its matches in the
// order they were said, up to limit.
export function buildSearchBody({
  query,
  mode = 'smart',
  sort = 'relevance',
  limit = 10,
  perSession = 1,
  includeTools = false,
  filters = {},
  sessionKeys = null,
  inSession = null
}) {
  const filter = buildFilters({ ...filters, includeTools });
  if (inSession) filter.push({ term: { session_key: inSession } });
  const includeToolFields = includeTools || Boolean(filters.tool);
  let textQuery;
  let highlight = null;
  const hitSource = [...HIT_SOURCE];

  if (mode === 'literal') {
    textQuery = {
      bool: {
        filter: [...filter, { wildcard: { 'text.sub': { value: `*${escapeWildcard(query)}*`, case_insensitive: true } } }]
      }
    };
    hitSource.push('text');
  } else {
    const parsed = parseQuery(query);
    const options = {
      includeTools: includeToolFields,
      prefix: mode === 'prefix' || mode === 'fuzzy' || mode === 'partial',
      fuzzy: mode === 'fuzzy' || mode === 'partial'
    };
    const clauses = parsed.groups.map(group => groupClause(group, options));
    const bool = { filter: [...filter] };
    if (mode === 'session') {
      bool.filter.push({ terms: { session_key: sessionKeys || [] } });
      bool.should = clauses;
      bool.minimum_should_match = 1;
    } else if (mode === 'partial' && clauses.length > 1) {
      bool.should = clauses;
      bool.minimum_should_match = clauses.length <= 2 ? 1 : '70%';
    } else if (clauses.length > 0) {
      bool.must = clauses;
    }
    if (parsed.excluded.length > 0) {
      bool.must_not = parsed.excluded.map(item => itemClause(item, { includeTools: includeToolFields }));
    }
    const words = parsed.groups.filter(group => group.length === 1 && group[0].type === 'term').map(group => group[0].text);
    if (words.length >= 2 && bool.must) {
      // Reward messages where the words sit close together.
      bool.should = [{ match_phrase: { text: { query: words.join(' '), slop: 4, boost: 2 } } }];
    }
    textQuery = { bool };

    const fields = { text: {}, 'text.stem': {} };
    if (includeToolFields) fields.tool_input = { number_of_fragments: 1 };
    // One fragment per match: the best-scoring stretch of the message.
    highlight = {
      type: 'unified',
      pre_tags: [HIGHLIGHT_OPEN],
      post_tags: [HIGHLIGHT_CLOSE],
      fragment_size: 240,
      number_of_fragments: 1,
      order: 'score',
      fields
    };
  }

  const byTime = { timestamp: { order: 'desc', missing: '_last' } };
  const useScore = sort === 'relevance' && mode !== 'literal';
  const sortSpec = useScore ? [{ _score: 'desc' }, byTime] : [byTime, { _score: 'desc' }];
  const scored = useScore
    ? {
        // Recent messages score up to twice as high as old ones, and what
        // the user asked counts a little more than what an agent narrated.
        function_score: {
          query: textQuery,
          functions: [
            { weight: 1 },
            {
              filter: { exists: { field: 'timestamp' } },
              exp: { timestamp: { origin: 'now', scale: '45d', offset: '3d', decay: 0.5 } },
              weight: 1
            },
            { filter: { bool: { filter: [{ term: { role: 'user' } }], must_not: [{ term: { injected: true } }] } }, weight: 0.3 }
          ],
          score_mode: 'sum',
          boost_mode: 'multiply'
        }
      }
    : textQuery;

  const innerHits = {
    name: 'messages',
    size: inSession ? limit : perSession,
    sort: inSession ? [{ seq: 'asc' }] : sortSpec,
    _source: hitSource
  };
  if (highlight) innerHits.highlight = highlight;

  return {
    size: inSession ? 1 : limit,
    track_total_hits: true,
    _source: false,
    query: scored,
    sort: sortSpec,
    collapse: { field: 'session_key', inner_hits: innerHits },
    aggs: inSession ? sessionCount : { ...sessionCount, ...FACETS }
  };
}

// Joins highlights that are split only by punctuation inside one identifier,
// so "submission-receipt" reads as one match instead of two.
export function mergeHighlights(fragment) {
  return fragment.replace(new RegExp(`${HIGHLIGHT_CLOSE}([._\\-/:@#+]{0,2})${HIGHLIGHT_OPEN}`, 'g'), '$1');
}

export function normalizeSearchResponse(data) {
  const groups = [];
  for (const top of data?.hits?.hits || []) {
    const inner = top.inner_hits?.messages?.hits;
    const hits = [];
    for (const hit of inner?.hits || []) {
      const source = hit._source || {};
      const highlight = hit.highlight || {};
      const textFragments = highlight.text || highlight['text.stem'] || [];
      const toolFragments = highlight.tool_input || [];
      hits.push({
        sessionKey: source.session_key,
        sessionId: source.session_id,
        shortId: source.short_id,
        source: source.source,
        project: source.project,
        role: source.role,
        injected: source.injected === true,
        subagent: source.subagent === true,
        parentSessionId: source.parent_session_id || null,
        app: source.app || null,
        desktopKind: source.desktop_kind || null,
        seq: source.seq,
        timestamp: source.timestamp || null,
        model: source.model || null,
        tools: source.tools || [],
        score: typeof hit._score === 'number' ? hit._score : null,
        fragments: textFragments.map(mergeHighlights),
        toolFragments: toolFragments.map(mergeHighlights),
        preview: source.preview || '',
        labels: source.labels && Object.keys(source.labels).length > 0 ? source.labels : null,
        text: source.text
      });
    }
    if (hits.length === 0) continue;
    groups.push({
      sessionKey: hits[0].sessionKey,
      matchesInSession: inner?.total?.value ?? hits.length,
      hits
    });
  }
  const facet = name => (data?.aggregations?.[name]?.buckets || [])
    .map(bucket => ({ value: bucket.key, sessions: bucket.sessions?.value ?? 0, messages: bucket.doc_count }))
    .filter(bucket => bucket.sessions > 0);
  const order = FACETS.when.date_range.ranges.map(range => range.key);
  return {
    totalMessages: data?.hits?.total?.value ?? 0,
    totalSessions: data?.aggregations?.sessions?.value ?? groups.length,
    groups,
    facets: {
      projects: facet('projects'),
      sources: facet('sources'),
      when: facet('when').sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
    }
  };
}

// Resolves a session id, short id, or id prefix (optionally "source:id") to
// the indexed sessions it matches.
export async function findIndexedSessions(client, index, fragment) {
  const qualified = String(fragment).match(/^(claude|codex|kimi):(.+)$/i);
  const id = (qualified ? qualified[2] : String(fragment)).replace(/^session_/, '');
  const filter = [
    { term: { kind: 'session' } },
    { bool: { should: [{ term: { session_id: id } }, { term: { short_id: id } }, { prefix: { session_id: id } }], minimum_should_match: 1 } }
  ];
  if (qualified) filter.push({ term: { source: qualified[1].toLowerCase() } });
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: { size: 10, query: { bool: { filter } }, _source: ['session_key', 'session_id', 'short_id', 'source', 'project', 'title'] }
  });
  return (data?.hits?.hits || []).map(hit => ({
    sessionKey: hit._source.session_key,
    sessionId: hit._source.session_id,
    shortId: hit._source.short_id,
    source: hit._source.source,
    project: hit._source.project,
    title: hit._source.title || null
  }));
}

// Finds the sessions in which every term group appears, each possibly in a
// different message. One request: a filter aggregation per group, each
// listing the sessions it matched, intersected here.
async function sessionsWithEveryTerm(client, index, options, parsed) {
  const includeTools = options.includeTools || Boolean(options.filters?.tool);
  const aggs = {};
  parsed.groups.forEach((group, position) => {
    aggs[`group_${position}`] = {
      filter: groupClause(group, { includeTools }),
      aggs: { sessions: { terms: { field: 'session_key', size: 10_000 } } }
    };
  });
  const bool = { filter: buildFilters({ ...options.filters, includeTools: options.includeTools }) };
  if (options.inSession) bool.filter.push({ term: { session_key: options.inSession } });
  if (parsed.excluded.length > 0) {
    bool.must_not = parsed.excluded.map(item => itemClause(item, { includeTools }));
  }
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: { size: 0, track_total_hits: false, query: { bool }, aggs },
    timeout: 20_000
  });
  let common = null;
  for (let position = 0; position < parsed.groups.length; position++) {
    const keys = new Set((data?.aggregations?.[`group_${position}`]?.sessions?.buckets || []).map(bucket => bucket.key));
    common = common === null ? keys : new Set([...common].filter(key => keys.has(key)));
    if (common.size === 0) break;
  }
  return [...(common || [])];
}

const TITLE_SOURCE = ['session_key', 'session_id', 'short_id', 'source', 'project', 'title', 'named', 'session_started_at',
  'session_modified_at', 'subagent', 'parent_session_id', 'app', 'desktop_kind'];
// A title is the session's name only for some sessions, and which ones is
// read from each document, not asked of the index: an index that was built
// before names were kept has no field to ask. So matching titles are read a
// page at a time, newest first, until enough named ones are found.
const TITLE_PAGE = 200;
const TITLE_PAGES = 5;
const TITLE_POOL = 50;
// The most sessions a search adds for their name alone.
const TITLE_ROWS = 3;

// Named sessions whose name holds every term of the query, newest first. The
// name is how a session is known in the app that ran it, and often nobody
// said it in the session, so no message matches. Sessions without a real
// name are left out: their title is the prompt they began with, or what a
// subagent was asked to do, which message search covers.
async function namedSessions(client, index, { query, filters = {} }) {
  const parsed = parseQuery(query);
  if (parsed.groups.length === 0) return [];
  const clause = item => ({ match_phrase: { title: { query: item.text, slop: item.type === 'near' ? 40 : 0 } } });
  const filter = [{ term: { kind: 'session' } }];
  if (filters.source && filters.source !== 'all') filter.push({ term: { source: filters.source } });
  if (filters.project) {
    const value = `*${escapeWildcard(filters.project)}*`;
    filter.push({
      bool: {
        should: [
          { wildcard: { project: { value, case_insensitive: true } } },
          { wildcard: { project_encoded: { value, case_insensitive: true } } }
        ],
        minimum_should_match: 1
      }
    });
  }
  if (filters.since) filter.push({ range: { session_modified_at: { gte: new Date(filters.since).toISOString() } } });
  const bool = {
    filter,
    must: parsed.groups.map(group => (group.length === 1
      ? clause(group[0])
      : { bool: { should: group.map(clause), minimum_should_match: 1 } }))
  };
  if (parsed.excluded.length > 0) bool.must_not = parsed.excluded.map(clause);

  const found = [];
  let searchAfter = null;
  for (let page = 0; page < TITLE_PAGES && found.length < TITLE_POOL; page++) {
    const body = {
      size: TITLE_PAGE,
      track_total_hits: false,
      query: { bool },
      sort: [{ session_modified_at: { order: 'desc', missing: '_last' } }, { session_key: 'asc' }],
      _source: TITLE_SOURCE,
      highlight: {
        pre_tags: [HIGHLIGHT_OPEN],
        post_tags: [HIGHLIGHT_CLOSE],
        fields: { title: { number_of_fragments: 0 } }
      }
    };
    if (searchAfter) body.search_after = searchAfter;
    const { data } = await client.request('POST', `/${index}/_search`, { body, timeout: 10_000 });
    const hits = data?.hits?.hits || [];
    for (const hit of hits) {
      const source = hit._source || {};
      if (source.named !== true || source.subagent === true || !source.session_key) continue;
      found.push({
        sessionKey: source.session_key,
        sessionId: source.session_id,
        shortId: source.short_id,
        source: source.source,
        project: source.project,
        title: source.title || '',
        fragment: mergeHighlights(hit.highlight?.title?.[0] || source.title || ''),
        timestamp: source.session_started_at || source.session_modified_at || null,
        app: source.app || null,
        desktopKind: source.desktop_kind || null
      });
      if (found.length >= TITLE_POOL) break;
    }
    if (hits.length < TITLE_PAGE) break;
    searchAfter = hits[hits.length - 1].sort;
  }
  return found;
}

// Of the given sessions, those in which a message matches: asked with the
// very query the message search ran (`ran`), narrowed to these sessions.
async function sessionsThatSaidIt(client, index, options, ran, sessionKeys) {
  const asked = buildSearchBody({ ...options, ...ran, sort: 'recent', limit: 1, perSession: 1, inSession: null });
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: {
      size: 0,
      track_total_hits: false,
      query: { bool: { filter: [{ terms: { session_key: sessionKeys } }], must: [asked.query] } },
      aggs: { sessions: { terms: { field: 'session_key', size: sessionKeys.length } } }
    },
    timeout: 10_000
  });
  return new Set((data?.aggregations?.sessions?.buckets || []).map(bucket => bucket.key));
}

// A search by name makes no sense when the search is for an exact substring,
// inside one session, or about who spoke, which tool ran or what is labeled.
function wantsTitles(options) {
  const filters = options.filters || {};
  return !options.literal && !options.inSession && !filters.role && !filters.tool && !(filters.labels?.length > 0);
}

// Runs a search, loosening the match only when the stricter form found
// nothing. Returns the mode that produced the results, and `titles`: the
// sessions the query names and no message of which matched it. A session
// that a message already brings up is not listed a second time for its name,
// and its name never pushes a message match off the list. That is the rule
// the file scan follows too.
export async function searchSnapshot(client, index, rawOptions) {
  const [found, named] = await Promise.all([
    searchMessages(client, index, rawOptions),
    wantsTitles(rawOptions) ? namedSessions(client, index, rawOptions).catch(() => []) : []
  ]);
  const { ran, ...result } = found;
  let titles = named;
  // Once a search has had to loosen, no message matched outright anywhere,
  // so there is nothing to set aside.
  const outright = result.totalMessages > 0 && (result.mode === 'smart' || result.mode === 'literal');
  if (titles.length > 0 && outright) {
    const said = await sessionsThatSaidIt(client, index, rawOptions, ran, titles.map(entry => entry.sessionKey)).catch(() => null);
    // Without that answer a name could repeat a session, so none is shown.
    titles = said ? titles.filter(entry => !said.has(entry.sessionKey)) : [];
  }
  return { ...result, titles: titles.slice(0, TITLE_ROWS) };
}

async function searchMessages(client, index, rawOptions) {
  let options = rawOptions;
  if (options.filters?.labels?.length > 0) {
    const labelSessionKeys = await sessionKeysWithLabels(client, index, options.filters.labels);
    options = { ...options, filters: { ...options.filters, labelSessionKeys } };
  }
  // `ran` is what a result was asked with, for a follow-up question that has
  // to mean the same thing (see sessionsThatSaidIt).
  const run = async (mode, extra = {}) => {
    const body = buildSearchBody({ ...options, ...extra, mode });
    const { data } = await client.request('POST', `/${index}/_search`, { body, timeout: 20_000 });
    return { mode, ...normalizeSearchResponse(data), took: data?.took ?? null, ran: { mode, ...extra } };
  };

  if (options.literal) return run('literal');

  const parsed = parseQuery(options.query);
  // A query with nothing a tokenizer would keep ("=>", "&&") can only be
  // matched character for character.
  if (parsed.groups.length === 0 && parsed.excluded.length === 0) return run('literal');
  const terms = parsed.groups.flat().filter(item => item.type === 'term');
  const literal = literalText(options.query, parsed);

  let result = await run('smart');
  if (result.totalMessages > 0) return result;
  const strict = result;

  if (terms.some(item => isPlainWord(item.text))) {
    result = await run('prefix');
    if (result.totalMessages > 0) return result;
  }
  if (literal) {
    result = await run('literal', { query: literal });
    if (result.totalMessages > 0) return result;
  }
  if (!options.includeTools) {
    // Paths, flags, endpoints, and variable names often appear only in the
    // commands an agent ran, never in what anyone said.
    result = await run('smart', { includeTools: true });
    if (result.totalMessages > 0) return { ...result, mode: 'tools' };
  }
  if (parsed.groups.length > 1) {
    const sessionKeys = await sessionsWithEveryTerm(client, index, options, parsed);
    if (sessionKeys.length > 0) {
      result = await run('session', { sessionKeys });
      if (result.totalMessages > 0) return { ...result, totalSessions: sessionKeys.length };
    }
  }
  if (terms.some(item => isPlainWord(item.text, 4))) {
    result = await run('fuzzy');
    if (result.totalMessages > 0) return result;
  }
  if (parsed.groups.length > 1) {
    result = await run('partial');
    if (result.totalMessages > 0) return result;
  }
  return strict;
}

// Fetches the messages surrounding each hit. Returns Map("key:seq" -> [...]).
export async function fetchContext(client, index, hits, count) {
  const context = new Map();
  if (count <= 0 || hits.length === 0) return context;
  const should = hits.map(hit => ({
    bool: {
      filter: [
        { term: { session_key: hit.sessionKey } },
        { range: { seq: { gte: hit.seq - count, lte: hit.seq + count } } }
      ]
    }
  }));
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: {
      size: Math.min(10_000, hits.length * count * 2 + hits.length),
      query: {
        bool: {
          filter: [{ term: { kind: 'message' } }, { term: { has_text: true } }],
          should,
          minimum_should_match: 1
        }
      },
      sort: [{ session_key: 'asc' }, { seq: 'asc' }],
      _source: ['session_key', 'seq', 'role', 'preview']
    }
  });
  const bySession = new Map();
  for (const hit of data?.hits?.hits || []) {
    const source = hit._source || {};
    if (!bySession.has(source.session_key)) bySession.set(source.session_key, []);
    bySession.get(source.session_key).push(source);
  }
  for (const hit of hits) {
    const nearby = (bySession.get(hit.sessionKey) || [])
      .filter(message => message.seq !== hit.seq && Math.abs(message.seq - hit.seq) <= count)
      .map(message => ({
        type: message.role,
        text: message.preview || '',
        position: message.seq < hit.seq ? 'before' : 'after'
      }));
    context.set(`${hit.sessionKey}:${hit.seq}`, nearby);
  }
  return context;
}

// Fetches the first few user prompts of each session. Returns Map(key -> [...]).
export async function fetchPrompts(client, index, sessionKeys, count = 5) {
  const prompts = new Map();
  if (sessionKeys.length === 0) return prompts;
  const { data } = await client.request('POST', `/${index}/_search`, {
    body: {
      size: sessionKeys.length,
      _source: false,
      query: {
        bool: {
          filter: [
            { term: { kind: 'message' } },
            { term: { role: 'user' } },
            { term: { has_text: true } },
            { terms: { session_key: sessionKeys } }
          ]
        }
      },
      sort: [{ seq: 'asc' }],
      collapse: {
        field: 'session_key',
        inner_hits: { name: 'prompts', size: count, sort: [{ seq: 'asc' }], _source: ['preview', 'timestamp'] }
      }
    }
  });
  for (const top of data?.hits?.hits || []) {
    const key = top.fields?.session_key?.[0];
    const list = (top.inner_hits?.prompts?.hits?.hits || []).map(hit => ({
      text: hit._source?.preview || '',
      timestamp: hit._source?.timestamp || null
    }));
    if (key) prompts.set(key, list);
  }
  return prompts;
}
