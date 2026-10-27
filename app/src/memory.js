import crypto from 'crypto';
import { chicagoYmd, retentionCutoffMs, tokenize } from './time.js';

export const MEMORY_DEFAULTS = { version: 1, entries: [] };

function haystack(entry) {
  const bits = [];
  if (entry.summary) bits.push(entry.summary);
  if (entry.title) bits.push(entry.title);
  for (const d of entry.decisions || []) bits.push(d.text);
  for (const a of entry.actionItems || []) bits.push(a.text);
  for (const k of entry.keyStatements || []) bits.push(`${k.speaker || ''} ${k.text || ''}`);
  return bits.join(' ').toLowerCase();
}

export function scoreMemoryEntry(entry, query) {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const text = haystack(entry);
  if (!text) return 0;
  let score = 0;
  for (const t of tokens) {
    if (text.includes(t)) score += 1;
  }
  const phrase = String(query || '').toLowerCase().trim();
  if (phrase.length >= 4 && text.includes(phrase)) score += 3;
  return score;
}

export function filterEntriesByWindow(entries, { now = new Date(), retentionDays = 60 } = {}) {
  const cutoff = retentionCutoffMs(now instanceof Date ? now : new Date(now), retentionDays);
  return (entries || []).filter((e) => {
    const ts = Date.parse(e.createdAt || e.date || '');
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

/**
 * Recall decisions / action items / key statements in the retention window.
 */
export function recallMemory(entries, { query, now = new Date(), retentionDays = 60, limit = 8 } = {}) {
  const windowed = filterEntriesByWindow(entries, { now, retentionDays });
  const q = String(query || '').trim();
  const ranked = windowed
    .map((entry) => ({
      entry,
      score: q ? scoreMemoryEntry(entry, q) : 1,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.entry.createdAt).localeCompare(String(a.entry.createdAt));
    })
    .slice(0, limit);

  return {
    ok: true,
    query: q || null,
    retentionDays,
    windowStart: new Date(retentionCutoffMs(now, retentionDays)).toISOString(),
    matchCount: ranked.length,
    matches: ranked.map(({ entry, score }) => ({
      score,
      id: entry.id,
      date: entry.date,
      createdAt: entry.createdAt,
      channel: entry.channel || null,
      conversationId: entry.conversationId || null,
      callSid: entry.callSid || null,
      title: entry.title || null,
      summary: entry.summary || null,
      decisions: entry.decisions || [],
      actionItems: entry.actionItems || [],
      keyStatements: entry.keyStatements || [],
    })),
  };
}

function asItems(list, at) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      if (item == null) return null;
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text, at } : null;
      }
      const text = String(item.text || item.statement || '').trim();
      if (!text) return null;
      return {
        text,
        at: item.at || at,
        speaker: item.speaker || null,
      };
    })
    .filter(Boolean);
}

export function buildMemoryEntry(args = {}, { now = new Date(), timeZone = 'America/Chicago' } = {}) {
  const at = now.toISOString();
  return {
    id: args.id || `mem_${crypto.randomBytes(8).toString('hex')}`,
    createdAt: at,
    date: args.date || chicagoYmd(now, timeZone),
    channel: args.channel || null,
    conversationId: args.conversationId || null,
    callSid: args.callSid || null,
    title: args.title ? String(args.title).slice(0, 200) : null,
    summary: args.summary ? String(args.summary).slice(0, 4000) : '',
    decisions: asItems(args.decisions, at),
    actionItems: asItems(args.actionItems || args.action_items, at),
    keyStatements: asItems(args.keyStatements || args.key_statements, at),
  };
}

export function remember(store, args, opts = {}) {
  const entry = buildMemoryEntry(args, opts);
  const retentionDays = opts.retentionDays ?? 60;
  store.update((data) => {
    const cur = data && Array.isArray(data.entries) ? data : { ...MEMORY_DEFAULTS, ...data, entries: [] };
    cur.entries.push(entry);
    cur.entries = filterEntriesByWindow(cur.entries, { now: opts.now || new Date(), retentionDays });
    cur.version = 1;
    return cur;
  });
  return { ok: true, id: entry.id, date: entry.date, conversationId: entry.conversationId };
}

export function loadAndRecall(store, queryOpts = {}) {
  const data = store.read();
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return recallMemory(entries, queryOpts);
}
