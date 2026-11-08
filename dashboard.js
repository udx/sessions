const state = {
  sessions: [],
  status: 'all',
  source: 'all',
  project: 'all',
  query: ''
};

const elements = {
  list: document.querySelector('#session-list'),
  empty: document.querySelector('#empty-state'),
  loading: document.querySelector('#loading-state'),
  refresh: document.querySelector('#refresh-button'),
  refreshStatus: document.querySelector('#refresh-status'),
  search: document.querySelector('#search-input'),
  source: document.querySelector('#source-filter'),
  project: document.querySelector('#project-filter'),
  advancedFilters: document.querySelector('#advanced-filters'),
  clear: document.querySelector('#clear-button'),
  results: document.querySelector('#results-count'),
  toast: document.querySelector('#toast')
};

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

function sourceName(source) {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function baseFilteredSessions() {
  const query = state.query.trim().toLowerCase();
  return state.sessions.filter(session => {
    if (state.source !== 'all' && session.source !== state.source) return false;
    if (state.project !== 'all' && session.project !== state.project) return false;
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
  });
}

function filteredSessions() {
  return baseFilteredSessions().filter(session => {
    if (state.status === 'active') return session.active;
    if (state.status === 'past') return !session.active;
    return true;
  });
}

function updateStats() {
  const active = state.sessions.filter(session => session.active).length;
  const projects = new Set(state.sessions.map(session => session.project));
  document.querySelector('#total-stat').textContent = numberFormat.format(state.sessions.length);
  document.querySelector('#active-stat').textContent = numberFormat.format(active);
  document.querySelector('#projects-stat').textContent = numberFormat.format(projects.size);
}

function renderProjects() {
  const previous = state.project;
  const projects = [...new Set(state.sessions.map(session => session.project))]
    .sort((a, b) => a.localeCompare(b));
  elements.project.replaceChildren(element('option', '', 'All project folders'));
  elements.project.firstElementChild.value = 'all';
  for (const project of projects) {
    const option = element('option', '', project);
    option.value = project;
    elements.project.append(option);
  }
  elements.project.value = projects.includes(previous) ? previous : 'all';
  state.project = elements.project.value;
}

function createActivityChart(session) {
  const chart = element('div', 'activity-chart');
  const days = session.activity || [];
  const total = days.reduce((sum, day) => sum + day.count, 0);
  chart.title = `Last 7 days: ${numberFormat.format(total)} messages`;

  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 140 28');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${total} messages over the last seven days`);
  const maximum = Math.max(1, ...days.map(day => day.count));
  days.forEach((day, index) => {
    const date = new Date(`${day.date}T12:00:00`);
    const height = day.count ? Math.max(3, Math.round(day.count / maximum * 26)) : 1;
    const bar = document.createElementNS(namespace, 'rect');
    bar.setAttribute('x', String(index * 20 + 2));
    bar.setAttribute('y', String(28 - height));
    bar.setAttribute('width', '12');
    bar.setAttribute('height', String(height));
    bar.setAttribute('rx', '1');
    bar.setAttribute('class', `activity-bar${day.count ? '' : ' empty'}${index === days.length - 1 ? ' today' : ''}`);
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
    heading.append(element('span', 'transcript-speaker', message.type === 'user' ? 'You' : sourceName(message.source)));
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
  const card = element('article', 'session-card');
  const main = element('div', 'session-main');
  const titleLine = element('div', 'session-title-line');
  if (session.active) {
    const status = element('span', 'session-status active');
    status.title = 'Active session';
    status.setAttribute('role', 'img');
    status.setAttribute('aria-label', 'Active session');
    titleLine.append(status);
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
  titleLine.append(title);

  const project = element('div', 'project-row');
  project.title = session.project;
  project.append(element('span', 'project-path', session.project));

  const meta = element('div', 'session-meta');
  meta.append(element('span', '', sourceName(session.source)));
  meta.append(element('span', '', `${numberFormat.format(session.messageCount)} ${session.messageCount === 1 ? 'message' : 'messages'}`));
  if (session.model) meta.append(element('span', 'model-name', session.model));
  if (session.archived) meta.append(element('span', '', 'Archived'));

  main.append(titleLine, project, meta);

  const side = element('div', 'session-side');
  const relative = element('div', `last-active${session.active ? ' active' : ''}`, formatRelativeTime(session.lastActiveAt));
  relative.dataset.relativeTime = session.lastActiveAt;
  const exact = element('time', 'exact-time', formatExactTime(session.lastActiveAt));
  exact.dateTime = session.lastActiveAt;
  exact.title = new Date(session.lastActiveAt).toLocaleString();
  const copy = element('button', 'button resume-button', 'Copy command');
  copy.type = 'button';
  copy.dataset.command = session.resumeCommand;
  copy.title = session.resumeCommand;
  copy.setAttribute('aria-label', `Copy command to resume ${session.title || session.shortId}`);
  side.append(relative, exact, createActivityChart(session), copy);

  card.append(main, side);
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
  const hasAdvancedFilters = state.source !== 'all' || state.project !== 'all';
  elements.list.replaceChildren(...sessions.map(createSessionCard));
  elements.list.setAttribute('aria-busy', 'false');
  elements.empty.hidden = sessions.length > 0 || !attemptedLoad;
  elements.results.hidden = !hasFilters;
  elements.results.textContent = `${numberFormat.format(sessions.length)} shown`;
  elements.advancedFilters.classList.toggle('has-active', hasAdvancedFilters);
  elements.clear.hidden = !hasFilters;
  updateStats();
}

function updateRefreshStatus() {
  if (refreshing) {
    elements.refreshStatus.textContent = 'Refreshing sessions…';
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
  elements.refresh.textContent = 'Refreshing…';
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
    elements.empty.querySelector('p').textContent = 'Try another search or clear the filters.';
    renderProjects();
    render();
  } catch (error) {
    refreshFailed = true;
    if (!attemptedLoad) {
      elements.empty.querySelector('h2').textContent = 'Could not load sessions';
      elements.empty.querySelector('p').textContent = 'Check the terminal running sessions --serve for details.';
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
elements.source.addEventListener('change', () => {
  state.source = elements.source.value;
  render();
});
elements.project.addEventListener('change', () => {
  state.project = elements.project.value;
  render();
});
elements.clear.addEventListener('click', () => {
  state.query = '';
  state.source = 'all';
  state.project = 'all';
  state.status = 'all';
  elements.search.value = '';
  elements.source.value = 'all';
  elements.project.value = 'all';
  elements.advancedFilters.open = false;
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
