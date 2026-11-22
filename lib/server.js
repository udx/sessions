import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything the page is made of sits in dashboard/, beside lib/.
const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
const staticFiles = new Map([
  ['/', ['dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript; charset=utf-8']],
  // The typefaces ship with the tool: the page may not load anything from
  // outside this machine.
  ...['ibm-plex-sans-400', 'ibm-plex-sans-500', 'ibm-plex-mono-400', 'ibm-plex-mono-500']
    .map(name => [`/fonts/${name}.woff2`, [`fonts/${name}.woff2`, 'font/woff2']])
]);

function isoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function activityDays(meta, modifiedAt, now) {
  const recorded = meta.activityByDay || {};
  const fallback = Object.keys(recorded).length === 0 && meta.messageCount > 0
    ? { [localDayKey(modifiedAt)]: meta.messageCount }
    : recorded;
  const days = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDayKey(date);
    days.push({ date: key, count: fallback[key] || 0 });
  }
  return days;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const viewCommand = session => `sessions show ${shellQuote(`${session.source}:${session.sessionId}`)}`;

function resumeCommand(session) {
  // A Cowork session keeps its transcript inside the desktop app and is
  // carried on there. The command that works from a terminal reads it.
  if (session.app === 'desktop' && session.desktopKind && session.desktopKind !== 'code') return viewCommand(session);
  const id = shellQuote(session.sessionId);
  const command = session.source === 'claude'
    ? `claude --resume ${id}`
    : session.source === 'codex'
      ? `codex resume ${id}`
      : `kimi --session ${shellQuote(`session_${session.sessionId}`)}`;
  const project = session.project || '';
  return path.isAbsolute(project) ? `cd ${shellQuote(project)} && ${command}` : command;
}

function emptyMeta() {
  return {
    firstPrompt: null,
    timestamp: null,
    userCount: 0,
    assistantCount: 0,
    model: null,
    messageCount: 0,
    activityByDay: {}
  };
}

export async function startSessionServer(options) {
  const {
    host = '127.0.0.1',
    port = 4220,
    activeMinutes = 15,
    open = false,
    getSessionFiles,
    getSessionMeta,
    streamSessionMessages,
    extractTextContent
  } = options;
  const metadataCache = new Map();
  let pendingSnapshot = null;

  async function describeSession(session, now) {
    const key = `${session.source}:${session.sessionId}:${session.filePath}`;
    const fingerprint = `${session.modifiedAt.getTime()}:${session.size}`;
    const cached = metadataCache.get(key);
    let meta;

    if (cached?.fingerprint === fingerprint) {
      meta = cached.meta;
    } else {
      try {
        meta = await getSessionMeta(session, true);
        metadataCache.set(key, { fingerprint, meta });
      } catch {
        meta = cached?.meta || emptyMeta();
      }
    }

    const archived = session.archived === true;
    const modifiedAt = session.modifiedAt.getTime();
    const prompt = meta.displayPrompt || meta.firstPrompt;
    const title = session.title && prompt?.startsWith(session.title)
      ? prompt
      : session.title || prompt || null;
    return {
      sessionId: session.sessionId,
      shortId: session.shortId,
      source: session.source,
      project: session.project,
      title,
      firstPrompt: prompt,
      model: meta.model,
      userCount: meta.userCount,
      assistantCount: meta.assistantCount,
      messageCount: meta.messageCount,
      activity: activityDays(meta, session.modifiedAt, now),
      size: session.size,
      startedAt: isoTimestamp(session.startedAt || meta.timestamp),
      lastActiveAt: isoTimestamp(session.modifiedAt),
      active: !archived && now - modifiedAt <= activeMinutes * 60_000,
      archived,
      resumeCommand: resumeCommand(session),
      viewCommand: viewCommand(session)
    };
  }

  async function buildSnapshot() {
    const sessions = await getSessionFiles();
    const now = Date.now();
    const described = new Array(sessions.length);
    const liveKeys = new Set(sessions.map(session => `${session.source}:${session.sessionId}:${session.filePath}`));
    for (const key of metadataCache.keys()) {
      if (!liveKeys.has(key)) metadataCache.delete(key);
    }

    let nextIndex = 0;
    async function worker() {
      while (nextIndex < sessions.length) {
        const index = nextIndex++;
        described[index] = await describeSession(sessions[index], now);
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, sessions.length) }, worker));

    return {
      generatedAt: new Date(now).toISOString(),
      activeMinutes,
      sessions: described
    };
  }

  function getSnapshot() {
    if (!pendingSnapshot) {
      pendingSnapshot = buildSnapshot().finally(() => {
        pendingSnapshot = null;
      });
    }
    return pendingSnapshot;
  }

  async function findSession(source, sessionId) {
    const sessions = await getSessionFiles(null, source);
    return sessions.find(session => session.sessionId === sessionId) || null;
  }

  async function readTranscript(session, limit, before) {
    const messages = [];
    const toolsUsed = new Set();
    let total = 0;
    await streamSessionMessages(session, data => {
      const content = data.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && block.name) toolsUsed.add(block.name);
        }
      }
      if (!['user', 'assistant'].includes(data.type)) return;
      const text = extractTextContent(content).trim();
      if (!text) return;
      const index = total++;
      if (before !== null && index >= before) return true;
      messages.push({
        type: data.type,
        source: session.source,
        timestamp: data.timestamp || null,
        model: data.message?.model || null,
        text: text.slice(0, 4000),
        truncated: text.length > 4000
      });
      if (messages.length > limit) messages.shift();
    });
    const earlierThan = before === null ? total : before;
    return {
      messages,
      total,
      nextBefore: Math.max(0, earlierThan - messages.length),
      hasMore: earlierThan > messages.length,
      toolsUsed: [...toolsUsed].sort()
    };
  }

  function send(req, res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) {
        send(req, res, 405, JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (url.pathname === '/api/sessions') {
        send(req, res, 200, JSON.stringify(await getSnapshot()));
        return;
      }
      const messagesMatch = url.pathname.match(/^\/api\/sessions\/(claude|codex|kimi)\/([^/]+)\/messages$/);
      if (messagesMatch) {
        const source = messagesMatch[1];
        const sessionId = decodeURIComponent(messagesMatch[2]);
        const session = await findSession(source, sessionId);
        if (!session) {
          send(req, res, 404, JSON.stringify({ error: 'Session not found' }));
          return;
        }
        const requestedLimit = Number(url.searchParams.get('limit') || 8);
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 8;
        const requestedBefore = url.searchParams.get('before');
        const parsedBefore = requestedBefore === null ? null : Number(requestedBefore);
        const before = parsedBefore === null || !Number.isInteger(parsedBefore) || parsedBefore < 0 ? null : parsedBefore;
        send(req, res, 200, JSON.stringify(await readTranscript(session, limit, before)));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        send(req, res, 204, '');
        return;
      }

      const staticFile = staticFiles.get(url.pathname);
      if (staticFile) {
        const [filename, type] = staticFile;
        const content = await fs.readFile(path.join(DASHBOARD_DIR, filename));
        send(req, res, 200, content, type);
        return;
      }
      send(req, res, 404, JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      console.error(`Dashboard request failed: ${error.message}`);
      send(req, res, 500, JSON.stringify({ error: 'Request failed' }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const urlHost = displayHost.includes(':') ? `[${displayHost}]` : displayHost;
  const url = `http://${urlHost}:${address.port}`;
  console.log(`Sessions dashboard: ${url}`);
  console.log(`Auto-refreshes every 60 seconds. Active means updated within ${activeMinutes} minutes. Press Ctrl+C to stop.`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn('Warning: session metadata is visible to anyone who can reach this address.');
  }

  if (open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.error(`Could not open a browser. Visit ${url}`));
    child.unref();
  }

  return server;
}
