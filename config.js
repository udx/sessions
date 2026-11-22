import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_INDEX = 'sessions';
export const DEFAULT_KEEP = 1;
export const DEFAULT_AUTO_SYNC_MINUTES = 10;
// The most transcript, in megabytes, that a search will index on its own
// before answering. What does not fit waits for the next search or for
// "sessions sync". Large enough to take in a long session that is still being
// written, which is often the one worth finding.
export const DEFAULT_AUTO_SYNC_MAX_MB = 1024;

const BACKEND_ALIASES = new Map([
  ['auto', 'auto'],
  ['es', 'elasticsearch'],
  ['elastic', 'elasticsearch'],
  ['elasticsearch', 'elasticsearch'],
  ['local', 'local'],
  ['files', 'local'],
  ['scan', 'local']
]);

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function normalizeBackend(value) {
  if (value === undefined || value === null || value === '') return null;
  return BACKEND_ALIASES.get(String(value).toLowerCase()) || null;
}

export function configPath(env = process.env) {
  if (env.SESSIONS_CONFIG) return env.SESSIONS_CONFIG;
  return path.join(os.homedir(), '.sessions', 'config.yaml');
}

async function readConfigFile(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  const { default: yaml } = await import('js-yaml');
  const parsed = yaml.load(text);
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a YAML mapping at the top level');
  }
  return parsed;
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return false;
  return TRUE_VALUES.has(String(value).toLowerCase());
}

function asPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : fallback;
}

function asNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// auto_sync: minutes after which a search refreshes the index first.
// true means the default interval; false, 0, or nothing turns it off.
function asMinutes(value) {
  if (value === undefined || value === null || value === false || value === '') return 0;
  const number = Number(value);
  if (typeof value !== 'boolean' && Number.isFinite(number)) return number > 0 ? number : 0;
  return value === true || ['true', 'yes', 'on'].includes(String(value).toLowerCase()) ? DEFAULT_AUTO_SYNC_MINUTES : 0;
}

// An index name doubles as the alias and as the snapshot prefix, so it has to
// satisfy Elasticsearch's index naming rules on its own.
export function isValidIndexName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{0,100}$/.test(name);
}

// Transcripts are private, so writing them anywhere but this machine has to be
// an explicit decision. host.docker.internal resolves to this host from inside
// a container, which is how containerized workers reach a local cluster.
export function isLoopbackUrl(value) {
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

// Strips credentials so a URL is safe to print.
export function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return String(value);
  }
}

// Precedence: explicit overrides (CLI flags), then SESSIONS_* environment
// variables, then ~/.sessions/config.yaml. The generic ELASTICSEARCH_URL is
// never read: it commonly points at a shared cluster, and transcripts must not
// end up there by accident.
export async function loadConfig({ env = process.env, overrides = {} } = {}) {
  const file = configPath(env);
  let fileConfig = null;
  let warning = null;
  try {
    fileConfig = await readConfigFile(file);
    if (fileConfig === null && !env.SESSIONS_CONFIG && file.endsWith('.yaml')) {
      const alternate = file.replace(/\.yaml$/, '.yml');
      fileConfig = await readConfigFile(alternate);
    }
  } catch (error) {
    warning = `Ignoring ${file}: ${error.message.split('\n')[0]}`;
  }
  const loaded = fileConfig !== null;
  fileConfig ||= {};

  const es = fileConfig.elasticsearch && typeof fileConfig.elasticsearch === 'object' ? fileConfig.elasticsearch : {};
  const search = fileConfig.search && typeof fileConfig.search === 'object' ? fileConfig.search : {};

  const url = overrides.url || env.SESSIONS_ES_URL || env.SESSIONS_ELASTICSEARCH_URL || es.url || null;
  const index = overrides.index || env.SESSIONS_ES_INDEX || es.index || DEFAULT_INDEX;
  const requestedBackend = overrides.backend || env.SESSIONS_SEARCH_BACKEND || search.backend;
  const backend = normalizeBackend(requestedBackend);
  if (requestedBackend && !backend && !warning) {
    warning = `Unknown search backend "${requestedBackend}"; expected auto, elasticsearch, or local`;
  }

  return {
    file,
    loaded,
    warning,
    elasticsearch: {
      url: url ? String(url) : null,
      index: String(index),
      apiKey: env.SESSIONS_ES_API_KEY || es.api_key || es.apiKey || null,
      username: env.SESSIONS_ES_USERNAME || es.username || null,
      password: env.SESSIONS_ES_PASSWORD || es.password || null,
      allowRemote: overrides.allowRemote === true ||
        asBoolean(env.SESSIONS_ES_ALLOW_REMOTE) ||
        asBoolean(es.allow_remote ?? es.allowRemote),
      keep: asPositiveInteger(overrides.keep ?? es.keep, DEFAULT_KEEP),
      autoSyncMinutes: asMinutes(env.SESSIONS_ES_AUTO_SYNC ?? es.auto_sync ?? es.autoSync),
      autoSyncMaxMb: asNonNegativeNumber(env.SESSIONS_ES_AUTO_SYNC_MAX_MB ?? es.auto_sync_max_mb ?? es.autoSyncMaxMb, DEFAULT_AUTO_SYNC_MAX_MB)
    },
    search: {
      // "auto" uses Elasticsearch when a URL is configured and quietly falls
      // back to scanning files when the cluster or snapshot is unavailable.
      backend: backend || 'auto'
    }
  };
}
