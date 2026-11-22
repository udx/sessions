// File-scan search: answers the same query language as the Elasticsearch
// backend by reading the transcripts directly, so a search means the same
// thing whether or not an index exists.
//
// Without an index there is nothing to rank with, so sessions are read newest
// first and the scan stops once enough of them matched. Words match as
// case-insensitive substrings ("deploy" finds "deployed" and "redeploy").

import { HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE, isInjectedUserText, parseQuery, toolInputText } from './query.js';

const NEAR_SPAN = 400;       // characters allowed between the parts of a.*b
const FRAGMENT_CHARS = 240;  // one highlighted stretch of a message
const FRAGMENT_LEAD = 40;    // text kept in front of the first match
const CONTEXT_CHARS = 600;   // kept from each neighboring message
const CLOSE_SPAN = 200;      // terms this near each other count as together
const PREVIEW_CHARS = 300;

// The match modes this backend can answer with, strictest first. They are a
// subset of the Elasticsearch ones and carry the same meaning:
//   smart    every term in one message
//   literal  the query as one exact substring (--literal, or a query made
//            only of punctuation)
//   tools    every term in one message once its tool calls are read too
//   session  every term somewhere in the same session
//   partial  most of the terms in one message
// A session whose name holds every term matches as well, with a hit of type
// "title": the name is how a session is known in the app that ran it, and it
// is often not a word anyone said in the session.
export const LOCAL_MATCH_MODES = ['smart', 'literal', 'tools', 'session', 'partial'];

function compileItem(item) {
  if (item.type === 'near') {
    const pieces = item.text.toLowerCase().split(/\s+/).filter(Boolean);
    return { type: 'near', pieces, needles: pieces };
  }
  const needle = item.text.toLowerCase().replace(/\s+/g, ' ');
  return { type: item.type, needle, needles: [needle], spaced: needle.includes(' ') };
}

// Turns a query string into matchers. groups are AND-ed, the items inside a
// group are OR-ed, and a message matching an excluded item never counts.
export function compileQuery(query, { literal = false } = {}) {
  const raw = String(query ?? '');
  const parsed = literal ? { groups: [], excluded: [] } : parseQuery(raw);
  if (literal || (parsed.groups.length === 0 && parsed.excluded.length === 0)) {
    const needle = raw.toLowerCase();
    return {
      literal: true,
      groups: [[{ type: 'literal', needle, needles: [needle], spaced: false }]],
      excluded: [],
      phrase: null
    };
  }
  // A query of plain words also ranks messages that contain it word for word.
  const plain = parsed.groups.length > 1 && parsed.groups.every(group => group.length === 1 && group[0].type === 'term');
  return {
    literal: false,
    groups: parsed.groups.map(group => group.map(compileItem)),
    excluded: parsed.excluded.map(compileItem),
    phrase: plain ? parsed.groups.map(group => group[0].text.toLowerCase()).join(' ') : null
  };
}

function haystack(text) {
  const lower = text.toLowerCase();
  let flat = null;
  return { lower, flat: () => (flat ??= lower.replace(/\s+/g, ' ')) };
}

function itemMatches(item, hay) {
  if (item.type === 'near') {
    const [first, ...rest] = item.pieces;
    let start = hay.lower.indexOf(first);
    while (start !== -1) {
      let position = start + first.length;
      let ordered = true;
      for (const piece of rest) {
        const next = hay.lower.indexOf(piece, position);
        if (next === -1 || next - position > NEAR_SPAN) { ordered = false; break; }
        position = next + piece.length;
      }
      if (ordered) return true;
      start = hay.lower.indexOf(first, start + 1);
    }
    return false;
  }
  return (item.spaced ? hay.flat() : hay.lower).includes(item.needle);
}

// Whether every term first appears within a short stretch of the text. A
// rough stand-in for proximity ranking: enough to tell a sentence that uses
// the terms together from a long summary that merely contains them all.
function termsTogether(groups, hay) {
  if (groups.length < 2) return false;
  let first = Infinity;
  let last = -1;
  for (const group of groups) {
    let at = -1;
    for (const item of group) {
      const needle = item.type === 'near' ? item.pieces[0] : item.needle;
      const found = (item.spaced ? hay.flat() : hay.lower).indexOf(needle);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    if (at === -1) return false;
    first = Math.min(first, at);
    last = Math.max(last, at);
  }
  return last - first <= CLOSE_SPAN;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Up to `max` highlighted stretches of a text. The first covers as many of
// the needles as fit in one stretch; later ones pick up what it missed.
export function fragmentsOf(text, needles, max = 2) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const wanted = [...new Set(needles.filter(Boolean))];
  if (!flat || wanted.length === 0) return [];
  const anyNeedle = new RegExp(wanted.map(escapeRegExp).sort((a, b) => b.length - a.length).join('|'), 'gi');
  const occurrences = [];
  for (let match = anyNeedle.exec(flat); match !== null && occurrences.length < 400; match = anyNeedle.exec(flat)) {
    if (match[0].length === 0) { anyNeedle.lastIndex++; continue; }
    occurrences.push({ at: match.index, end: match.index + match[0].length, needle: match[0].toLowerCase() });
  }
  if (occurrences.length === 0) return [];

  const fragments = [];
  const covered = new Set();
  let cursor = -1;
  while (fragments.length < max) {
    let best = null;
    for (const start of occurrences) {
      if (start.at <= cursor) continue;
      const limit = start.at - FRAGMENT_LEAD + FRAGMENT_CHARS;
      const fresh = new Set();
      for (const other of occurrences) {
        if (other.at < start.at) continue;
        if (other.end > limit) break;
        if (!covered.has(other.needle)) fresh.add(other.needle);
      }
      if (!best || fresh.size > best.fresh.size) best = { start, fresh };
      if (best.fresh.size === wanted.length - covered.size) break;
    }
    if (!best) break;
    // A later stretch has to add something, unless one needle is all there is.
    if (fragments.length > 0 && best.fresh.size === 0 && wanted.length > 1) break;
    const from = Math.max(0, best.start.at - FRAGMENT_LEAD);
    const to = Math.min(flat.length, from + FRAGMENT_CHARS);
    for (const needle of best.fresh) covered.add(needle);
    cursor = to;
    const painted = flat.slice(from, to).replace(anyNeedle, found => `${HIGHLIGHT_OPEN}${found}${HIGHLIGHT_CLOSE}`);
    fragments.push(`${from > 0 ? '…' : ''}${painted}${to < flat.length ? '…' : ''}`);
  }
  return fragments;
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function createBucket() {
  return { count: 0, hits: [] };
}

// Keeps the best `keep` hits of a bucket in order.
function offer(bucket, hit, better, keep) {
  bucket.count++;
  const { hits } = bucket;
  if (hits.length >= keep && better(hits[hits.length - 1], hit) <= 0) return;
  let position = hits.length;
  while (position > 0 && better(hits[position - 1], hit) > 0) position--;
  hits.splice(position, 0, hit);
  if (hits.length > keep) hits.pop();
}

// Comparators return a negative number when the first hit should come first.
const byScore = (a, b) => (b.score - a.score) || (b.seq - a.seq);
const byRecency = (a, b) => b.seq - a.seq;
const byPosition = (a, b) => a.seq - b.seq;
const byCoverage = (a, b) => (b.matched - a.matched) || (b.score - a.score) || (b.seq - a.seq);

// Searches the given sessions, which the caller has already filtered and
// sorted newest first.
//
// limit:      sessions to return, each with up to perSession matches
// inSession:  the sessions list holds one session; return its matches in the
//             order they were said, up to limit
// context:    neighboring messages to attach to each match
//
// Returns { mode, groups, totalMessages, totalSessions, complete, scanned,
// available, unreadable }. `complete` is false when the scan stopped early,
// in which case the totals only describe the sessions that were read.
export async function searchFiles({
  query,
  sessions,
  reader,
  limit = 10,
  perSession = 1,
  context = 0,
  literal = false,
  includeTools = false,
  tool = null,
  role = null,
  sort = 'relevance',
  inSession = false
}) {
  const { streamSessionMessages, extractTextContent } = reader;
  const compiled = compileQuery(query, { literal });
  const groupCount = compiled.groups.length;
  // An exact-substring search reads message text only, as it does with an index.
  const searchTools = !compiled.literal && (includeTools || Boolean(tool));
  const wantedTool = tool ? String(tool).toLowerCase() : null;
  const needles = [...new Set(compiled.groups.flat().flatMap(item => item.needles))];
  // Same rule as the Elasticsearch backend: one of two terms, else 70%.
  const partialNeed = groupCount < 2 ? Infinity : groupCount === 2 ? 1 : Math.floor(groupCount * 0.7);
  const keep = Math.max(1, inSession ? limit : perSession);
  const primaryOrder = inSession ? byPosition : sort === 'recent' ? byRecency : byScore;
  const titleSearch = !compiled.literal && groupCount > 0 && !inSession && !role && !tool;

  const tiers = { full: [], tools: [], session: [], partial: [] };
  const totals = {
    full: { sessions: 0, messages: 0 },
    tools: { sessions: 0, messages: 0 },
    session: { sessions: 0, messages: 0 },
    partial: { sessions: 0, messages: 0 }
  };
  let scanned = 0;
  let unreadable = 0;
  let stoppedEarly = false;

  for (const session of sessions) {
    if (!inSession && tiers.full.length >= limit) {
      stoppedEarly = true;
      break;
    }
    scanned++;
    // Looser matches only matter while nothing has matched outright, and an
    // exact-substring search never loosens.
    const loose = totals.full.sessions === 0 && !compiled.literal;
    const found = { full: createBucket(), tools: createBucket(), any: createBucket(), partial: createBucket() };
    const seenGroups = new Array(groupCount).fill(false);
    const recent = [];
    const waiting = [];
    let seq = -1;
    // The name the session was found with. What a subagent was asked to do
    // is a description, not a name, and does not answer a search by name.
    const title = session.named === true && typeof session.title === 'string' && session.title.trim()
      ? session.title.trim()
      : null;
    let firstTimestamp = null;

    const visit = (data) => {
      if (data.type !== 'user' && data.type !== 'assistant') return;
      seq++;
      if (firstTimestamp === null && data.timestamp) firstTimestamp = data.timestamp;
      const content = data.message?.content;
      const text = extractTextContent(content) || '';
      const hasText = text.trim().length > 0;

      if (context > 0 && hasText) {
        const entry = { type: data.type, text: text.slice(0, CONTEXT_CHARS) };
        for (let i = waiting.length - 1; i >= 0; i--) {
          if (seq - waiting[i].seq > context) waiting.splice(i, 1);
          else waiting[i].after.push(entry);
        }
        recent.push({ seq, ...entry });
        while (recent.length > 0 && seq - recent[0].seq > context) recent.shift();
      }
      if (role && data.type !== role) return;

      const toolNames = [];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use' && block.name && !toolNames.includes(block.name)) toolNames.push(block.name);
        }
      }
      if (wantedTool && !toolNames.some(name => name.toLowerCase() === wantedTool)) return;
      const readTools = (searchTools || loose) && toolNames.length > 0;
      if (!hasText && !readTools) return;

      const hayText = hasText ? haystack(text) : null;
      let toolText = null;
      let hayTool = null;
      const toolHay = () => {
        if (hayTool === null) {
          toolText = content.filter(block => block && block.type === 'tool_use')
            .map(block => toolInputText(block.input)).filter(Boolean).join('\n\n');
          hayTool = haystack(toolText);
        }
        return hayTool;
      };

      let inText = 0;
      let inAny = 0;
      const textGroups = [];
      const anyGroups = [];
      for (const group of compiled.groups) {
        const viaText = hayText !== null && group.some(item => itemMatches(item, hayText));
        const viaAny = viaText || (readTools && group.some(item => itemMatches(item, toolHay())));
        if (viaText) inText++;
        if (viaAny) inAny++;
        textGroups.push(viaText);
        anyGroups.push(viaAny);
      }
      const excludedText = hayText !== null && compiled.excluded.some(item => itemMatches(item, hayText));
      const excludedTool = readTools && compiled.excluded.length > 0 && compiled.excluded.some(item => itemMatches(item, toolHay()));

      const matched = searchTools ? inAny : inText;
      const excluded = excludedText || (searchTools && excludedTool);
      const isFull = !excluded && matched === groupCount && (hasText || searchTools);
      const viaTools = !excludedText && !excludedTool && !searchTools && groupCount > 0 && inAny === groupCount && !isFull;
      if (!isFull && !loose) return;
      if (!isFull && !viaTools && (excluded || matched === 0)) return;

      const injected = data.type === 'user' && hasText && (session.subagent === true || isInjectedUserText(text));
      const wordForWord = compiled.phrase !== null && hayText !== null && hayText.flat().includes(compiled.phrase);
      const together = wordForWord || (hayText !== null && inText === groupCount && termsTogether(compiled.groups, hayText));
      // Which match of a session leads: the query word for word, then its
      // terms used together, then something the user typed. Text a tool put
      // under the user role comes last: a compaction summary holds nearly
      // every word of its session.
      const score = (wordForWord ? 4 : 0) + (together ? 2 : 0) +
        (data.type === 'user' && !injected ? 1 : 0) - (injected ? 1 : 0);
      const usedTools = searchTools || viaTools;
      // Context arrays are shared by every copy of a hit, so messages that
      // arrive later reach all of them.
      const hit = {
        seq,
        timestamp: data.timestamp || null,
        role: data.type,
        model: data.message?.model || null,
        injected,
        tools: toolNames,
        matched,
        score,
        text: hasText ? text : null,
        toolText: usedTools && readTools ? (toolHay(), toolText) : null,
        usedTools,
        before: context > 0
          ? recent.filter(entry => entry.seq < seq && seq - entry.seq <= context).map(({ type, text: nearby }) => ({ type, text: nearby }))
          : [],
        after: []
      };
      if (context > 0) waiting.push(hit);

      if (isFull) {
        offer(found.full, hit, primaryOrder, keep);
        return;
      }
      if (viaTools) offer(found.tools, { ...hit, matched: groupCount }, byScore, keep);
      if (!excluded && matched > 0) {
        (searchTools ? anyGroups : textGroups).forEach((seen, position) => { if (seen) seenGroups[position] = true; });
        offer(found.any, hit, byCoverage, keep);
        if (matched >= partialNeed) offer(found.partial, hit, byCoverage, keep);
      }
    };

    try {
      await streamSessionMessages(session, visit);
    } catch {
      unreadable++;
      continue;
    }

    // The name matches when it holds every term and none that is excluded.
    // It only speaks for a session that no message already brought up, and
    // not when the search is about who said something or which tool ran.
    if (found.full.count === 0 && title && titleSearch) {
      const hay = haystack(title);
      const named = compiled.groups.every(group => group.some(item => itemMatches(item, hay))) &&
        !compiled.excluded.some(item => itemMatches(item, hay));
      if (named) {
        offer(found.full, {
          seq: 0,
          timestamp: firstTimestamp,
          role: 'title',
          model: null,
          injected: false,
          tools: [],
          matched: groupCount,
          score: 0,
          text: title,
          toolText: null,
          usedTools: false,
          before: [],
          after: []
        }, primaryOrder, keep);
      }
    }

    const record = (tier, bucket, rank = null) => {
      totals[tier].sessions++;
      totals[tier].messages += bucket.count;
      const group = { session, title, matchesInSession: bucket.count, hits: bucket.hits.map(hit => finishHit(hit, needles)), rank };
      if (tier === 'partial') {
        // Best coverage first; sessions that tie stay newest first.
        const list = tiers.partial;
        let position = list.length;
        while (position > 0 && list[position - 1].rank < rank) position--;
        list.splice(position, 0, group);
        if (list.length > limit) list.pop();
      } else if (tiers[tier].length < limit || inSession) {
        tiers[tier].push(group);
      }
    };

    if (found.full.count > 0) {
      if (totals.full.sessions === 0) tiers.tools = tiers.session = tiers.partial = [];
      record('full', found.full);
      continue;
    }
    if (!loose) continue;
    if (found.tools.count > 0) record('tools', found.tools);
    if (groupCount > 1 && seenGroups.every(Boolean)) record('session', found.any);
    if (found.partial.count > 0) record('partial', found.partial, found.partial.hits[0].matched);
  }

  const tier = ['full', 'tools', 'session', 'partial'].find(name => tiers[name].length > 0) || 'full';
  return {
    mode: tier === 'full' ? (compiled.literal ? 'literal' : 'smart') : tier,
    groups: tiers[tier],
    totalMessages: totals[tier].messages,
    totalSessions: totals[tier].sessions,
    complete: !stoppedEarly,
    scanned,
    available: sessions.length,
    unreadable
  };
}

// Replaces a hit's raw text with what gets shown: highlighted fragments.
function finishHit(hit, needles) {
  const { text, toolText, usedTools, ...rest } = hit;
  return {
    ...rest,
    fragments: text ? fragmentsOf(text, needles) : [],
    toolFragments: usedTools && toolText ? fragmentsOf(toolText, needles, 1) : [],
    preview: text ? oneLine(text, PREVIEW_CHARS) : ''
  };
}
