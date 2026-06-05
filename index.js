#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const c = chalk;

function formatRelativeTime(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days > 7) return date.toISOString().split('T')[0];
  if (days > 1) return `${days} days ago`;
  if (days === 1) return 'yesterday';
  if (hours > 1) return `${hours} hours ago`;
  if (hours === 1) return '1 hour ago';
  if (minutes > 1) return `${minutes} minutes ago`;
  if (minutes === 1) return '1 minute ago';
  return 'just now';
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

function hasTextContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(block => block && block.type === 'text' && block.text && block.text.trim());
  }
  return false;
}

function truncate(text, maxLength = 80) {
  const oneLine = text.replace(/\n+/g, ' ').replace(/[#*`_~>|\-]{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 1) + '\u2026';
}

function cleanSnippet(text) {
  let cleaned = text;
  cleaned = cleaned.replace(/```[\w]*\n[\s\S]*?\n```/g, '[code block]');
  cleaned = cleaned.replace(/^\|.*\|$/gm, '');
  cleaned = cleaned.replace(/^[\s]*[-*] /gm, '  - ');
  cleaned = cleaned.replace(/#{1,6}\s+/g, '');
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function wrapText(text, width, indent = 2) {
  if (!text) return '';
  const prefix = ' '.repeat(indent);
  const lines = text.split('\n');
  const wrapped = [];
  for (const line of lines) {
    if (line.length <= width - indent) {
      wrapped.push(prefix + line);
    } else {
      let remaining = line;
      while (remaining.length > width - indent) {
        let breakAt = remaining.lastIndexOf(' ', width - indent);
        if (breakAt <= 0) breakAt = width - indent;
        wrapped.push(prefix + remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
      }
      if (remaining) wrapped.push(prefix + remaining);
    }
  }
  return wrapped.join('\n');
}

async function streamLines(filePath, callback) {
  const stream = createReadStream(filePath);
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const stop = callback(data);
        if (stop === true) break;
      } catch {}
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function resolveProjectPath(encodedDir) {
  const projectDir = path.join(PROJECTS_DIR, encodedDir);
  const files = await fs.readdir(projectDir);
  const firstSession = files.find(f => f.endsWith('.jsonl'));
  if (!firstSession) return encodedDir;

  let cwd = null;
  await streamLines(path.join(projectDir, firstSession), (data) => {
    if (data.cwd) { cwd = data.cwd; return true; }
  });
  return cwd || encodedDir;
}

async function getAllProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const entries = await fs.readdir(PROJECTS_DIR);
  const projects = [];

  for (const entry of entries) {
    const projectDir = path.join(PROJECTS_DIR, entry);
    const stat = await fs.stat(projectDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const files = await fs.readdir(projectDir);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
    if (sessionFiles.length === 0) continue;

    let totalSize = 0;
    for (const file of sessionFiles) {
      const s = await fs.stat(path.join(projectDir, file)).catch(() => null);
      if (s) totalSize += s.size;
    }

    const decoded = await resolveProjectPath(entry);

    projects.push({
      encoded: entry,
      path: decoded,
      sessionCount: sessionFiles.length,
      totalSize
    });
  }

  return projects.sort((a, b) => a.path.localeCompare(b.path));
}

async function getSessionFiles(projectFilter = null) {
  const projects = await getAllProjects();
  const sessions = [];

  for (const project of projects) {
    if (projectFilter && !project.path.includes(projectFilter)) continue;

    const projectDir = path.join(PROJECTS_DIR, project.encoded);
    const files = await fs.readdir(projectDir);
    const sessionFiles = files.filter(f => f.endsWith('.jsonl'));

    for (const file of sessionFiles) {
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(projectDir, file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;

      sessions.push({
        sessionId,
        shortId: sessionId.slice(0, 8),
        project: project.path,
        projectEncoded: project.encoded,
        filePath,
        size: stat.size,
        modifiedAt: stat.mtime
      });
    }
  }

  return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

async function getSessionMeta(filePath) {
  let firstPrompt = null;
  let timestamp = null;
  let userCount = 0;
  let assistantCount = 0;
  let model = null;

  await streamLines(filePath, (data) => {
    if (data.type === 'user') {
      userCount++;
      if (!firstPrompt) {
        const text = extractTextContent(data.message?.content);
        if (text) firstPrompt = text;
        if (data.timestamp) timestamp = data.timestamp;
      }
    } else if (data.type === 'assistant') {
      assistantCount++;
      if (!model && data.message?.model) model = data.message.model;
    }
  });

  return { firstPrompt, timestamp, userCount, assistantCount, model, messageCount: userCount + assistantCount };
}

async function getSessionMetaFast(filePath) {
  let firstPrompt = null;
  let timestamp = null;
  let model = null;

  await streamLines(filePath, (data) => {
    if (data.type === 'user' && !firstPrompt) {
      const text = extractTextContent(data.message?.content);
      if (text) firstPrompt = text;
      if (data.timestamp) timestamp = data.timestamp;
    }
    if (data.type === 'assistant' && !model && data.message?.model) {
      model = data.message.model;
    }
    if (firstPrompt && model) return true;
  });

  return { firstPrompt, timestamp, model };
}

function findSession(sessions, idFragment) {
  return sessions.find(s =>
    s.sessionId === idFragment ||
    s.sessionId.startsWith(idFragment) ||
    s.shortId === idFragment
  );
}

function formatMessageBlock(msg, opts = {}) {
  const termWidth = process.stdout.columns || 120;
  const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';

  if (msg.type === 'summary') {
    return c.italic.dim(`  Summary: ${truncate(msg.summary, termWidth - 12)}`);
  }

  if (msg.type === 'user') {
    const text = extractTextContent(msg.message?.content);
    if (!text || !text.trim()) return null;
    const header = c.bold.cyan('\u25b6 You') + c.dim(` ${ts}`);
    return header + '\n' + wrapText(text, termWidth);
  }

  if (msg.type === 'assistant') {
    const modelName = msg.message?.model || 'claude';
    const content = msg.message?.content;
    const parts = [];

    if (typeof content === 'string') {
      if (content.trim()) parts.push(wrapText(content, termWidth));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          parts.push(wrapText(block.text, termWidth));
        } else if (block.type === 'tool_use' && !opts.noTools) {
          const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input);
          parts.push(c.dim(`  \u{1f527} ${block.name}: ${truncate(inputStr, termWidth - 10)}`));
        }
      }
    }

    if (parts.length === 0) return null;

    const header = c.bold.green('\u25c0 Claude') + c.dim(` (${modelName}) ${ts}`);
    return header + '\n' + parts.join('\n');
  }

  return null;
}

program
  .name('sessions')
  .description('Search and browse Claude Code session transcripts')
  .version(pkg.version);

program
  .command('list')
  .description('List sessions across all projects')
  .option('-p, --project <path>', 'Filter by project path (substring match)')
  .option('-n, --limit <n>', 'Max sessions to show', '20')
  .option('--since <date>', 'Sessions since date (YYYY-MM-DD)')
  .option('--full', 'Show full message counts (slower)')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    let sessions = await getSessionFiles(opts.project);
    const limit = parseInt(opts.limit);

    if (opts.since) {
      const since = new Date(opts.since);
      sessions = sessions.filter(s => s.modifiedAt >= since);
    }

    const shown = sessions.slice(0, limit);

    if (opts.json) {
      const out = [];
      for (const s of shown) {
        const meta = opts.full ? await getSessionMeta(s.filePath) : await getSessionMetaFast(s.filePath);
        out.push({ ...s, ...meta, display: meta.firstPrompt || null });
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (shown.length === 0) {
      console.log('No sessions found.');
      return;
    }

    console.log(c.bold(`${sessions.length} sessions`) + c.dim(` (showing ${shown.length})\n`));

    for (const s of shown) {
      const meta = opts.full ? await getSessionMeta(s.filePath) : await getSessionMetaFast(s.filePath);
      const preview = meta.firstPrompt ? truncate(meta.firstPrompt, 90) : c.dim('(empty)');
      const time = formatRelativeTime(s.modifiedAt);
      const msgInfo = meta.messageCount ? `${meta.messageCount} msg` : '';

      console.log(
        c.yellow(s.shortId) + ' ' +
        c.dim(s.project) + ' ' +
        c.cyan(time) + ' ' +
        (msgInfo ? c.dim(`(${msgInfo}) `) : '') +
        c.dim(formatSize(s.size))
      );
      console.log(`  ${preview}\n`);
    }
  });

program
  .command('search <query>')
  .description('Full-text search across session transcripts')
  .option('-p, --project <path>', 'Filter by project path')
  .option('-n, --limit <n>', 'Max results', '10')
  .option('-C, --context <n>', 'Context messages around match', '0')
  .option('--since <date>', 'Only search sessions modified since date (YYYY-MM-DD)')
  .option('--json', 'Output JSON')
  .action(async (query, opts) => {
    let sessions = await getSessionFiles(opts.project);
    const limit = parseInt(opts.limit);
    const contextN = parseInt(opts.context);
    const lowerQuery = query.toLowerCase();
    const results = [];
    const sessionMatchCounts = new Map();
    const sessionTotalCounts = new Map();

    if (opts.since) {
      const since = new Date(opts.since);
      sessions = sessions.filter(s => s.modifiedAt >= since);
    }

    for (const session of sessions) {
      if (results.length >= limit * 3) break;

      const allMessages = [];
      await streamLines(session.filePath, (data) => {
        if (data.type === 'user' || data.type === 'assistant') {
          allMessages.push(data);
        }
      });

      let totalHits = 0;
      for (let mi = 0; mi < allMessages.length; mi++) {
        const data = allMessages[mi];
        const text = extractTextContent(data.message?.content);
        if (!text || !text.toLowerCase().includes(lowerQuery)) continue;

        totalHits++;
        const count = sessionMatchCounts.get(session.shortId) || 0;
        sessionMatchCounts.set(session.shortId, count + 1);

        const cleaned = cleanSnippet(text);
        const lines = cleaned.split('\n').filter(l => l.trim());
        const matchLines = [];
        const seen = new Set();
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lowerQuery)) {
            const start = Math.max(0, i - 1);
            const end = Math.min(lines.length - 1, i + 1);
            const snippet = [];
            for (let j = start; j <= end; j++) {
              if (seen.has(j)) continue;
              seen.add(j);
              let l = lines[j];
              if (l.length > 200) l = l.slice(0, 200) + '\u2026';
              if (j === i) {
                l = l.replace(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                  m => c.bold.yellow(m));
              }
              snippet.push(l);
            }
            if (snippet.length > 0) matchLines.push(snippet.join('\n'));
          }
        }

        const contextMessages = [];
        if (contextN > 0) {
          const start = Math.max(0, mi - contextN);
          const end = Math.min(allMessages.length - 1, mi + contextN);
          for (let ci = start; ci <= end; ci++) {
            if (ci === mi) continue;
            const ctxData = allMessages[ci];
            const ctxText = extractTextContent(ctxData.message?.content);
            if (ctxText && ctxText.trim()) {
              contextMessages.push({
                type: ctxData.type,
                text: truncate(ctxText, 150),
                position: ci < mi ? 'before' : 'after'
              });
            }
          }
        }

        results.push({
          sessionId: session.sessionId,
          shortId: session.shortId,
          project: session.project,
          timestamp: data.timestamp,
          type: data.type,
          model: data.message?.model,
          snippets: matchLines.slice(0, 2),
          contextMessages
        });
      }

      if (totalHits > 0) {
        sessionTotalCounts.set(session.shortId, totalHits);
      }
    }

    const sorted = results.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).slice(0, limit);

    if (opts.json) {
      console.log(JSON.stringify(sorted, null, 2));
      return;
    }

    if (sorted.length === 0) {
      console.log(`No matches for "${query}".`);
      return;
    }

    console.log(c.bold(`${results.length} matches`) + c.dim(` (showing ${sorted.length})\n`));

    for (const r of sorted) {
      const time = r.timestamp ? formatRelativeTime(r.timestamp) : '';
      const who = r.type === 'user' ? c.cyan('you') : c.green('claude');
      const totalInSession = sessionTotalCounts.get(r.shortId) || 0;
      const hits = totalInSession > 1 ? c.dim(` (${totalInSession} matches in session)`) : '';
      console.log(
        c.yellow(r.shortId) + ' ' +
        c.dim(r.project) + ' ' +
        who + ' ' +
        c.dim(time) +
        hits
      );
      if (r.contextMessages) {
        for (const ctx of r.contextMessages.filter(m => m.position === 'before')) {
          const ctxWho = ctx.type === 'user' ? c.dim.cyan('  [you]') : c.dim.green('  [claude]');
          console.log(ctxWho + c.dim(` ${ctx.text}`));
        }
      }
      for (const snippet of r.snippets) {
        console.log('  ' + snippet.split('\n').map(l => '  ' + l).join('\n'));
      }
      if (r.contextMessages) {
        for (const ctx of r.contextMessages.filter(m => m.position === 'after')) {
          const ctxWho = ctx.type === 'user' ? c.dim.cyan('  [you]') : c.dim.green('  [claude]');
          console.log(ctxWho + c.dim(` ${ctx.text}`));
        }
      }
      console.log('');
    }
  });

program
  .command('show <session-id>')
  .description('Display a session transcript')
  .option('--user-only', 'Show only user messages')
  .option('--assistant-only', 'Show only assistant messages')
  .option('--no-tools', 'Hide tool use blocks')
  .option('--preview', 'Show first few user prompts only (quick overview)')
  .option('-n, --limit <n>', 'Max messages to show')
  .option('--offset <n>', 'Skip first N messages', '0')
  .option('--json', 'Output JSON')
  .action(async (sessionId, opts) => {
    const sessions = await getSessionFiles();
    const session = findSession(sessions, sessionId);

    if (!session) {
      console.error(c.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }

    const messages = [];
    let idx = 0;
    const offset = parseInt(opts.offset);
    const previewMode = opts.preview;
    const limit = opts.limit ? parseInt(opts.limit) : (previewMode ? 5 : Infinity);
    const noTools = opts.tools === false;
    const filterUser = previewMode ? !opts.assistantOnly : opts.userOnly;

    await streamLines(session.filePath, (data) => {
      if (data.type === 'summary') {
        if (!filterUser && !opts.assistantOnly) messages.push(data);
        return;
      }
      if (data.type !== 'user' && data.type !== 'assistant') return;
      if (filterUser && data.type !== 'user') return;
      if (opts.assistantOnly && data.type !== 'assistant') return;

      if (opts.assistantOnly || noTools) {
        if (!hasTextContent(data.message?.content)) return;
      }

      idx++;
      if (idx <= offset) return;
      if (messages.length >= limit) return true;
      messages.push(data);
    });

    if (opts.json) {
      console.log(JSON.stringify(messages, null, 2));
      return;
    }

    console.log(c.bold(`Session: ${session.sessionId}`));
    console.log(c.dim(`Project: ${session.project}`));
    console.log(c.dim(`Size: ${formatSize(session.size)}  Messages: ${messages.length}\n`));

    if (previewMode) {
      for (const msg of messages) {
        const text = extractTextContent(msg.message?.content);
        if (!text) continue;
        const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
        console.log(c.cyan(`  ${ts}`) + `  ${truncate(text, 100)}`);
      }
      return;
    }

    const showOpts = { noTools: noTools || opts.assistantOnly };
    for (const msg of messages) {
      const formatted = formatMessageBlock(msg, showOpts);
      if (formatted !== null) console.log(formatted + '\n');
    }
  });

program
  .command('projects')
  .description('List all projects with session data')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    const projects = await getAllProjects();

    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log('No projects found.');
      return;
    }

    console.log(c.bold(`${projects.length} projects\n`));

    for (const p of projects) {
      console.log(
        c.cyan(p.path) + ' ' +
        c.dim(`${p.sessionCount} session${p.sessionCount !== 1 ? 's' : ''}, ${formatSize(p.totalSize)}`)
      );
    }
  });

program
  .command('export <session-id>')
  .description('Export a session transcript')
  .option('-f, --format <fmt>', 'Output format: md, json, text', 'md')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action(async (sessionId, opts) => {
    const sessions = await getSessionFiles();
    const session = findSession(sessions, sessionId);

    if (!session) {
      console.error(c.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }

    const messages = [];
    await streamLines(session.filePath, (data) => {
      if (data.type === 'user' || data.type === 'assistant' || data.type === 'summary') {
        messages.push(data);
      }
    });

    const contentMessages = messages.filter(msg => {
      if (msg.type === 'summary') return true;
      return hasTextContent(msg.message?.content);
    });

    let output = '';

    if (opts.format === 'json') {
      output = JSON.stringify(contentMessages, null, 2);
    } else if (opts.format === 'text') {
      for (const msg of contentMessages) {
        if (msg.type === 'summary') {
          output += `[SUMMARY] ${msg.summary}\n\n`;
          continue;
        }
        const text = extractTextContent(msg.message?.content);
        if (!text || !text.trim()) continue;
        const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
        const who = msg.type === 'user' ? 'YOU' : 'CLAUDE';
        const model = msg.message?.model ? ` (${msg.message.model})` : '';
        output += `[${who}${model}] ${ts}\n${text}\n\n`;
      }
    } else {
      output += `# Session: ${session.sessionId}\n\n`;
      output += `**Project:** ${session.project}  \n`;
      output += `**Messages:** ${contentMessages.length}  \n\n---\n\n`;

      for (const msg of contentMessages) {
        if (msg.type === 'summary') {
          output += `> *Summary:* ${msg.summary}\n\n`;
          continue;
        }
        const text = extractTextContent(msg.message?.content);
        if (!text || !text.trim()) continue;
        const ts = msg.timestamp ? formatRelativeTime(msg.timestamp) : '';
        const who = msg.type === 'user' ? '**You**' : '**Claude**';
        const model = msg.message?.model ? ` *(${msg.message.model})*` : '';
        output += `### ${who}${model} \u2014 ${ts}\n\n${text}\n\n---\n\n`;
      }
    }

    if (opts.output) {
      await fs.writeFile(opts.output, output);
      console.error(`Written to ${opts.output}`);
    } else {
      process.stdout.write(output);
    }
  });

program
  .command('history')
  .description('Show recent prompts from global history')
  .option('-n, --limit <n>', 'Max entries', '20')
  .option('-s, --search <query>', 'Filter by prompt text')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    if (!existsSync(HISTORY_FILE)) {
      console.log('No history file found.');
      return;
    }

    const entries = [];
    await streamLines(HISTORY_FILE, (data) => {
      entries.push(data);
    });

    let filtered = entries.reverse();
    if (opts.search) {
      const q = opts.search.toLowerCase();
      filtered = filtered.filter(e => {
        const text = e.display || e.prompt || e.message || '';
        return text.toLowerCase().includes(q);
      });
    }

    const shown = filtered.slice(0, parseInt(opts.limit));

    if (opts.json) {
      console.log(JSON.stringify(shown, null, 2));
      return;
    }

    if (shown.length === 0) {
      console.log('No history entries found.');
      return;
    }

    console.log(c.bold(`${filtered.length} entries`) + c.dim(` (showing ${shown.length})\n`));

    for (const e of shown) {
      const time = e.timestamp ? formatRelativeTime(e.timestamp) : '';
      const prompt = truncate(e.display || e.prompt || e.message || '(empty)', 100);
      const proj = e.projectPath || e.project || '';
      console.log(c.cyan(time) + ' ' + c.dim(proj));
      console.log(`  ${prompt}\n`);
    }
  });

program.parse();
