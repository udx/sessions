const state = {
  sessions: [],
  status: 'all',
  source: 'all',
  project: 'all',
  query: '',
  sourceOrder: [],
  projectOrder: [],
  projectLabels: new Map()
};

const elements = {
  list: document.querySelector('#session-list'),
  empty: document.querySelector('#empty-state'),
  loading: document.querySelector('#loading-state'),
  refresh: document.querySelector('#refresh-button'),
  refreshStatus: document.querySelector('#refresh-status'),
  search: document.querySelector('#search-input'),
  rail: document.querySelector('.rail'),
  sources: document.querySelector('#source-list'),
  projects: document.querySelector('#project-list'),
  clear: document.querySelector('#clear-button'),
  results: document.querySelector('#results-count'),
  toast: document.querySelector('#toast')
};

// Sessions that ran in no project (a folder an app made for the one
// conversation, or the app's own sandbox) are filed together, under one
// entry at the end of the projects.
const NO_PROJECT = ':none';
const NO_PROJECT_LABEL = 'No project';
const projectOf = session => (session.noProject ? NO_PROJECT : session.project);

const numberFormat = new Intl.NumberFormat();
const expandedSessions = new Set();
const transcriptCache = new Map();
let refreshing = false;
let attemptedLoad = false;
let refreshFailed = false;
let lastUpdated = null;
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sessionKey(session) {
  return `${session.source}:${session.sessionId}`;
}

function formatRelativeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatExactTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

// An agent is named the way the command line prints it: [claude], [codex], [kimi].
function sourceTag(source) {
  return element('span', `tag tag-${source}`, `[${source}]`);
}

// Whether a session passes the current filters. A facet in the rail counts
// the sessions that pass every filter but its own.
function matches(session, query, { source = true, project = true } = {}) {
  if (source && state.source !== 'all' && session.source !== state.source) return false;
  if (project && state.project !== 'all' && projectOf(session) !== state.project) return false;
  if (state.status === 'active' && !session.active) return false;
  if (state.status === 'past' && session.active) return false;
  if (!query) return true;
  return [
    session.title,
    session.firstPrompt,
    session.project,
    session.model,
    session.sessionId,
    session.shortId,
    session.source
  ].some(value => String(value || '').toLowerCase().includes(query));
}

function currentQuery() {
  return state.query.trim().toLowerCase();
}

function filteredSessions() {
  const query = currentQuery();
  return state.sessions.filter(session => matches(session, query));
}

function updateStats() {
  const active = state.sessions.filter(session => session.active).length;
  const projects = new Set(state.sessions.filter(session => !session.noProject).map(session => session.project));
  document.querySelector('#total-stat').textContent = numberFormat.format(state.sessions.length);
  document.querySelector('#active-stat').textContent = numberFormat.format(active);
  document.querySelector('#projects-stat').textContent = numberFormat.format(projects.size);
}

// Folder names repeat under different parents, so a name that is not unique
// is shown with its parent.
function projectLabels(projects) {
  const parts = project => project.replace(/\/+$/, '').split('/').filter(Boolean);
  const base = project => parts(project).pop() || project;
  const uses = new Map();
  for (const project of projects) uses.set(base(project), (uses.get(base(project)) || 0) + 1);
  const labels = new Map();
  for (const project of projects) {
    const shared = uses.get(base(project)) > 1 && parts(project).length > 1;
    labels.set(project, shared ? parts(project).slice(-2).join('/') : base(project));
  }
  return labels;
}

// Projects are listed most recently used first, in an order that does not
// change while filtering, so a row stays where it was.
function indexSessions() {
  const latest = new Map();
  for (const session of state.sessions) {
    const at = Date.parse(session.lastActiveAt) || 0;
    const project = projectOf(session);
    if (!latest.has(project) || at > latest.get(project)) latest.set(project, at);
  }
  if (state.project !== 'all' && !latest.has(state.project)) state.project = 'all';
  latest.delete(NO_PROJECT);
  state.projectOrder = [...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a) || a.localeCompare(b));
  state.projectLabels = projectLabels(state.projectOrder);

  const known = ['claude', 'codex', 'kimi'];
  const present = new Set(state.sessions.map(session => session.source));
  state.sourceOrder = [...known.filter(source => present.has(source)), ...[...present].filter(source => !known.includes(source)).sort()];
  if (state.source !== 'all' && !present.has(state.source)) state.source = 'all';
}

function railItem(content, count, pressed, facet, value, title) {
  const button = element('button', 'rail-item');
  button.type = 'button';
  button.dataset.facet = facet;
  button.dataset.value = value;
  button.setAttribute('aria-pressed', String(pressed));
  if (title) button.title = title;
  const name = element('span', 'rail-name');
  name.append(content);
  button.append(name, element('span', 'rail-count', numberFormat.format(count)));
  return button;
}

function renderRail() {
  const query = currentQuery();
  const focused = document.activeElement?.closest?.('.rail-item');
  const focusedKey = focused ? [focused.dataset.facet, focused.dataset.value] : null;

  const bySource = new Map();
  const byProject = new Map();
  let sourceTotal = 0;
  let projectTotal = 0;
  for (const session of state.sessions) {
    if (matches(session, query, { source: false })) {
      sourceTotal++;
      bySource.set(session.source, (bySource.get(session.source) || 0) + 1);
    }
    if (matches(session, query, { project: false })) {
      projectTotal++;
      byProject.set(projectOf(session), (byProject.get(projectOf(session)) || 0) + 1);
    }
  }

  const sources = [railItem('All agents', sourceTotal, state.source === 'all', 'source', 'all')];
  for (const source of state.sourceOrder) {
    sources.push(railItem(sourceTag(source), bySource.get(source) || 0, state.source === source, 'source', source));
  }
  elements.sources.replaceChildren(...sources);

  const projects = [railItem('All projects', projectTotal, state.project === 'all', 'project', 'all')];
  for (const project of state.projectOrder) {
    const count = byProject.get(project) || 0;
    if (count === 0 && state.project !== project) continue;
    projects.push(railItem(state.projectLabels.get(project), count, state.project === project, 'project', project, project));
  }
  const unfiled = byProject.get(NO_PROJECT) || 0;
  if (unfiled > 0 || state.project === NO_PROJECT) {
    projects.push(railItem(NO_PROJECT_LABEL, unfiled, state.project === NO_PROJECT, 'project', NO_PROJECT, 'Sessions that did not run in a project folder'));
  }
  elements.projects.replaceChildren(...projects);

  if (focusedKey) {
    const again = [...elements.rail.querySelectorAll('.rail-item')]
      .find(item => item.dataset.facet === focusedKey[0] && item.dataset.value === focusedKey[1]);
    if (again) again.focus();
  }
}

function createActivityChart(session) {
  const chart = element('div', 'cell-activity activity-chart');
  const days = session.activity || [];
  const total = days.reduce((sum, day) => sum + day.count, 0);
  chart.title = `Last 7 days: ${numberFormat.format(total)} messages`;

  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 80 20');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${total} messages over the last seven days`);
  const maximum = Math.max(1, ...days.map(day => day.count));
  days.forEach((day, index) => {
    const date = new Date(`${day.date}T12:00:00`);
    const today = index === days.length - 1;
    const height = day.count ? Math.max(2, Math.round(day.count / maximum * 20)) : 2;
    const bar = document.createElementNS(namespace, 'rect');
    bar.setAttribute('x', String(index * 12));
    bar.setAttribute('y', String(20 - height));
    bar.setAttribute('width', '8');
    bar.setAttribute('height', String(height));
    const kind = !day.count ? ' empty' : today && session.active ? ' live' : today ? ' today' : '';
    bar.setAttribute('class', `activity-bar${kind}`);
    const label = `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${day.count} ${day.count === 1 ? 'message' : 'messages'}`;
    const title = document.createElementNS(namespace, 'title');
    title.textContent = label;
    bar.append(title);
    svg.append(bar);
  });
  chart.append(svg);
  return chart;
}

function sessionDetailsId(session) {
  return `details-${session.source}-${session.shortId}`;
}

function createSessionDetails(session) {
  const details = element('section', 'session-details');
  details.id = sessionDetailsId(session);
  details.dataset.sessionKey = sessionKey(session);
  details.hidden = true;
  details.setAttribute('aria-label', `Details for ${session.title || session.shortId}`);

  const facts = [
    session.startedAt ? `Started ${formatExactTime(session.startedAt)}` : null,
    `${numberFormat.format(session.userCount)} ${session.userCount === 1 ? 'prompt' : 'prompts'}`,
    `${numberFormat.format(session.assistantCount)} ${session.assistantCount === 1 ? 'response' : 'responses'}`,
    formatSize(session.size)
  ].filter(Boolean);
  details.append(element('div', 'detail-meta', facts.join(' · ')));

  if (session.firstPrompt) {
    const prompt = element('div', 'session-prompt markdown-body');
    prompt.append(renderSessionMarkdown(session.firstPrompt));
    details.append(prompt);
  }

  const view = element('div', 'view-command');
  view.append(element('code', '', session.viewCommand));
  const copy = element('button', 'button detail-copy', 'Copy view command');
  copy.type = 'button';
  copy.dataset.command = session.viewCommand;
  copy.title = session.viewCommand;
  view.append(copy);
  details.append(view);

  const transcript = element('div', 'transcript-preview');
  transcript.append(element('p', 'transcript-loading', 'Loading recent conversation…'));
  details.append(transcript);
  queueMicrotask(() => loadTranscript(details, session));
  return details;
}

async function fetchTranscript(session, before) {
  const suffix = before === null ? '' : `&before=${before}`;
  const response = await fetch(`/api/sessions/${session.source}/${encodeURIComponent(session.sessionId)}/messages?limit=8${suffix}`);
  if (!response.ok) throw new Error('Transcript failed');
  return response.json();
}

function renderTranscript(details, data) {
  const container = details.querySelector('.transcript-preview');
  const header = element('div', 'transcript-header');
  header.append(element('h3', '', 'Recent conversation'));
  if (data.hasMore) {
    const earlier = element('button', 'button earlier-button', 'Load earlier');
    earlier.type = 'button';
    earlier.dataset.earlier = details.dataset.sessionKey;
    header.append(earlier);
  }
  const children = [header];
  if (data.toolsUsed.length > 0) {
    const tools = data.toolsUsed.slice(0, 8).join(', ');
    const more = data.toolsUsed.length > 8 ? ` +${data.toolsUsed.length - 8} more` : '';
    children.push(element('div', 'transcript-tools', `Tools used: ${tools}${more}`));
  }
  for (const message of data.messages) {
    const row = element('div', `transcript-message ${message.type}`);
    const heading = element('div', 'transcript-message-heading');
    heading.append(message.type === 'user' ? element('span', 'transcript-speaker', 'you') : sourceTag(message.source));
    if (message.timestamp) heading.append(element('time', 'transcript-time', formatRelativeTime(message.timestamp)));
    const text = element('div', 'transcript-text markdown-body');
    text.append(renderSessionMarkdown(message.text));
    row.append(heading, text);
    children.push(row);
  }
  container.replaceChildren(...children);
}

async function loadTranscript(details, session) {
  const key = sessionKey(session);
  let request = transcriptCache.get(key);
  if (!request) {
    request = fetchTranscript(session, null);
    transcriptCache.set(key, request);
  }
  try {
    const data = await request;
    if (details.isConnected) renderTranscript(details, data);
  } catch {
    transcriptCache.delete(key);
    if (details.isConnected) {
      details.querySelector('.transcript-preview').textContent = 'Could not load the recent conversation.';
    }
  }
}

async function loadEarlier(button, details, session) {
  button.disabled = true;
  try {
    const key = sessionKey(session);
    const current = await transcriptCache.get(key);
    const older = await fetchTranscript(session, current.nextBefore);
    const merged = {
      ...older,
      messages: [...older.messages, ...current.messages],
      total: current.total,
      toolsUsed: [...new Set([...older.toolsUsed, ...current.toolsUsed])].sort()
    };
    transcriptCache.set(key, Promise.resolve(merged));
    if (details.isConnected) renderTranscript(details, merged);
  } catch {
    button.disabled = false;
  }
}

function createSessionCard(session) {
  const card = element('article', `session-card${session.active ? ' active' : ''}`);
  const row = element('div', 'row-grid');

  const cell = element('div', 'cell-session');
  const status = element('span', `session-status${session.active ? ' active' : ''}`);
  if (session.active) {
    status.title = 'Active session';
    status.setAttribute('role', 'img');
    status.setAttribute('aria-label', 'Active session');
  }

  const title = element('h2', 'session-title');
  const expand = element('button', 'session-expand', session.title || session.firstPrompt || '(empty session)');
  expand.type = 'button';
  expand.dataset.expand = sessionKey(session);
  expand.setAttribute('aria-expanded', 'false');
  expand.setAttribute('aria-controls', sessionDetailsId(session));
  expand.setAttribute('aria-label', `Show details for ${session.title || session.shortId}`);
  expand.title = `${session.shortId} · ${session.firstPrompt || session.title || ''}`;
  title.append(expand);

  const sub = element('div', 'session-sub');
  sub.append(element('span', 'session-id', session.shortId));
  if (session.model) sub.append(element('span', 'model-name', session.model));
  if (session.archived) sub.append(element('span', '', 'Archived'));
  cell.append(status, sourceTag(session.source), title, sub);

  const project = session.noProject
    ? element('div', 'cell-project none', NO_PROJECT_LABEL)
    : element('div', 'cell-project', state.projectLabels.get(session.project) || session.project);
  project.title = session.project;

  const count = element('div', 'cell-count', numberFormat.format(session.messageCount));
  count.title = `${numberFormat.format(session.messageCount)} ${session.messageCount === 1 ? 'message' : 'messages'}`;

  const time = element('div', 'cell-time');
  const relative = element('div', `last-active${session.active ? ' active' : ''}`, formatRelativeTime(session.lastActiveAt));
  relative.dataset.relativeTime = session.lastActiveAt;
  const exact = element('time', 'exact-time', formatExactTime(session.lastActiveAt));
  exact.dateTime = session.lastActiveAt;
  exact.title = new Date(session.lastActiveAt).toLocaleString();
  time.append(relative, exact);

  const action = element('div', 'cell-action');
  const copy = element('button', 'button resume-button', 'Copy command');
  copy.type = 'button';
  copy.dataset.command = session.resumeCommand;
  copy.title = session.resumeCommand;
  copy.setAttribute('aria-label', `Copy command to resume ${session.title || session.shortId}`);
  action.append(copy);

  row.append(cell, project, count, createActivityChart(session), time, action);
  card.append(row);
  if (expandedSessions.has(sessionKey(session))) {
    const details = createSessionDetails(session);
    details.hidden = false;
    card.append(details);
    card.classList.add('expanded');
    expand.setAttribute('aria-expanded', 'true');
  }
  return card;
}

function render() {
  const sessions = filteredSessions();
  const hasFilters = Boolean(state.query) || state.source !== 'all' || state.project !== 'all' || state.status !== 'all';
  elements.list.replaceChildren(...sessions.map(createSessionCard));
  elements.list.setAttribute('aria-busy', 'false');
  elements.empty.hidden = sessions.length > 0 || !attemptedLoad;
  elements.results.hidden = !hasFilters;
  elements.results.textContent = `${numberFormat.format(sessions.length)} shown`;
  elements.clear.hidden = !hasFilters;
  renderRail();
  updateStats();
}

function updateRefreshStatus() {
  if (refreshing) {
    elements.refreshStatus.textContent = 'Reading sessions';
  } else if (refreshFailed) {
    elements.refreshStatus.textContent = lastUpdated ? 'Refresh failed · will retry' : 'Could not load sessions';
  } else if (lastUpdated) {
    elements.refreshStatus.textContent = `Updated ${formatRelativeTime(lastUpdated).toLowerCase()}`;
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = element('textarea', 'clipboard-helper');
  textarea.value = text;
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy failed');
}

async function refreshSessions() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Refreshing';
  if (!attemptedLoad) elements.list.setAttribute('aria-busy', 'true');
  updateRefreshStatus();

  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    const data = await response.json();
    state.sessions = data.sessions;
    lastUpdated = new Date(data.generatedAt);
    document.querySelector('#active-window').textContent = data.activeMinutes;
    refreshFailed = false;
    attemptedLoad = true;
    elements.empty.querySelector('h2').textContent = 'No sessions found';
    elements.empty.querySelector('p').textContent = 'Try another search or clear the filters';
    indexSessions();
    render();
  } catch (error) {
    refreshFailed = true;
    if (!attemptedLoad) {
      elements.empty.querySelector('h2').textContent = 'Could not load sessions';
      elements.empty.querySelector('p').textContent = 'Check the terminal running sessions --serve for details';
      elements.empty.hidden = false;
    }
    console.error(error);
  } finally {
    attemptedLoad = true;
    refreshing = false;
    elements.loading.hidden = true;
    elements.list.setAttribute('aria-busy', 'false');
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Refresh';
    updateRefreshStatus();
  }
}

elements.refresh.addEventListener('click', refreshSessions);
elements.search.addEventListener('input', () => {
  state.query = elements.search.value;
  render();
});
elements.rail.addEventListener('click', event => {
  const item = event.target.closest('.rail-item');
  if (!item) return;
  state[item.dataset.facet] = item.dataset.value;
  render();
});
elements.clear.addEventListener('click', () => {
  state.query = '';
  state.source = 'all';
  state.project = 'all';
  state.status = 'all';
  elements.search.value = '';
  document.querySelectorAll('.tab').forEach(tab => {
    const selected = tab.dataset.status === 'all';
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
  render();
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.status = tab.dataset.status;
    document.querySelectorAll('.tab').forEach(other => {
      const selected = other === tab;
      other.classList.toggle('selected', selected);
      other.setAttribute('aria-pressed', String(selected));
    });
    render();
  });
});

elements.list.addEventListener('click', async event => {
  const earlier = event.target.closest('button[data-earlier]');
  if (earlier) {
    const session = state.sessions.find(item => sessionKey(item) === earlier.dataset.earlier);
    if (session) loadEarlier(earlier, earlier.closest('.session-details'), session);
    return;
  }

  const expand = event.target.closest('button[data-expand]');
  if (expand) {
    const card = expand.closest('.session-card');
    let details = card.querySelector('.session-details');
    if (!details) {
      const session = state.sessions.find(item => sessionKey(item) === expand.dataset.expand);
      if (!session) return;
      details = createSessionDetails(session);
      card.append(details);
    }
    const expanded = details.hidden;
    details.hidden = !expanded;
    expand.setAttribute('aria-expanded', String(expanded));
    card.classList.toggle('expanded', expanded);
    if (expanded) expandedSessions.add(expand.dataset.expand);
    else expandedSessions.delete(expand.dataset.expand);
    return;
  }

  const button = event.target.closest('button[data-command]');
  if (!button) return;
  const defaultLabel = button.textContent;
  try {
    await copyText(button.dataset.command);
    button.textContent = 'Copied';
    button.classList.add('copied');
    showToast('Command copied. Paste it into your terminal.');
    setTimeout(() => {
      if (!button.isConnected) return;
      button.textContent = defaultLabel;
      button.classList.remove('copied');
    }, 2200);
  } catch {
    showToast('Could not access the clipboard. Hover the button to see the command.');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && lastUpdated && Date.now() - lastUpdated.getTime() >= 60_000) {
    refreshSessions();
  }
});

setInterval(() => {
  if (document.visibilityState === 'visible') refreshSessions();
}, 60_000);
setInterval(updateRefreshStatus, 1000);
setInterval(() => {
  document.querySelectorAll('[data-relative-time]').forEach(node => {
    node.textContent = formatRelativeTime(node.dataset.relativeTime);
  });
}, 30_000);

refreshSessions();
