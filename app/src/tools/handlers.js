import fs from 'fs';
import path from 'path';
import { config, redact } from '../config.js';
import { getCallContext } from '../call-context.js';
import { transferLiveCall } from '../twilio/transfer.js';
import { notifyJason } from '../telegram.js';

function logTool(name, args, result) {
  console.log(`[tool:${name}]`, JSON.stringify(redact({ args, result })));
}

export async function transfer_to_jason(args = {}) {
  const ctx = getCallContext();
  const to = config.transferToJason;
  const phoneResult = await transferLiveCall(ctx?.callSid || null, to);
  const result = {
    ok: phoneResult.ok === true,
    transfer_to: phoneResult.to || to,
    reason: args.reason || null,
    caller_name: args.caller_name || null,
    caller_phone: args.caller_phone || ctx?.from || null,
    phone_layer: phoneResult,
    agent_hint:
      phoneResult.agent_hint ||
      (phoneResult.ok
        ? 'Transfer started. Stop talking — the caller is being dialed through to Jason.'
        : 'Transfer failed. Apologize and offer to take a message with save_message_for_jason. Do not claim they are connected.'),
  };
  if (phoneResult.ok) {
    void notifyJason(
      `📞 JV Assistant transferring call to you.\nFrom: ${result.caller_phone || 'unknown'}\nName: ${result.caller_name || 'unknown'}\nReason: ${result.reason || 'n/a'}`
    );
  }
  logTool('transfer_to_jason', args, result);
  return result;
}

export async function save_message_for_jason(args = {}) {
  const ctx = getCallContext();
  const callerPhone = args.caller_phone || ctx?.from || 'unknown';
  const callerName = args.caller_name || 'unknown';
  const message = String(args.message || '').trim();
  const urgency = args.urgency || 'normal';
  if (!message) {
    const result = { ok: false, error: 'missing_message', message: 'Need message text.' };
    logTool('save_message_for_jason', args, result);
    return result;
  }
  const stamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const text =
    `📨 JV Assistant message (${urgency})\n` +
    `When: ${stamp} CT\n` +
    `From: ${callerName} <${callerPhone}>\n` +
    `Message: ${message}`;
  const tg = await notifyJason(text);
  const result = {
    ok: tg.ok === true,
    delivered: tg.ok === true,
    telegram: tg,
    agent_hint: tg.ok
      ? 'Message delivered to Jason via Telegram. Confirm briefly to the caller.'
      : 'Could not reach Jason via Telegram. Apologize and offer transfer_to_jason or ask them to call/text again later.',
  };
  logTool('save_message_for_jason', args, result);
  return result;
}

/** Free DuckDuckGo Instant Answer + HTML lite fallback — no paid deps. */
export async function web_search(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    const result = { ok: false, error: 'missing_query' };
    logTool('web_search', args, result);
    return result;
  }
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'jgv-jv-assistant/0.1' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    const abstract = String(data.AbstractText || '').trim();
    const heading = String(data.Heading || '').trim();
    const related = Array.isArray(data.RelatedTopics)
      ? data.RelatedTopics.slice(0, 5)
          .map((t) => (typeof t === 'object' ? t.Text || t.FirstURL : null))
          .filter(Boolean)
      : [];
    const answer = abstract || related[0] || null;
    const result = {
      ok: Boolean(answer),
      query,
      heading: heading || null,
      answer: answer || null,
      related: related.slice(0, 3),
      source: 'duckduckgo',
      spokenSummary: answer
        ? `From public search: ${answer.slice(0, 500)}`
        : 'No clear public answer found. Do not invent facts — offer to take a message or transfer to Jason.',
      guidance:
        'Use only returned facts. For Jason private calendar/email/schedule, do NOT invent — use save_message_for_jason or transfer_to_jason.',
    };
    logTool('web_search', args, { ...result, answer: answer ? `[len=${answer.length}]` : null });
    return result;
  } catch (err) {
    const result = {
      ok: false,
      error: 'search_failed',
      message: err?.message || 'search_failed',
      spokenSummary: 'Search is unavailable right now. Offer to take a message or transfer to Jason.',
    };
    logTool('web_search', args, result);
    return result;
  }
}

function chicagoYmd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function parseYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
}

function weekdayName(ymd) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
  }).format(parseYmd(ymd));
}

function addDaysYmd(ymd, days) {
  const dt = parseYmd(ymd);
  dt.setUTCDate(dt.getUTCDate() + days);
  return chicagoYmd(dt);
}

function nextWeekdayOnOrAfter(fromYmd, weekdaySun0, { skipTodayIfMatch = false } = {}) {
  let ymd = fromYmd;
  for (let i = 0; i < 14; i++) {
    const dt = parseYmd(ymd);
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
    }).format(dt);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const cur = map[wd];
    if (cur === weekdaySun0) {
      if (i === 0 && skipTodayIfMatch) {
        ymd = addDaysYmd(ymd, 1);
        continue;
      }
      return ymd;
    }
    ymd = addDaysYmd(ymd, 1);
  }
  return null;
}

export async function resolve_calendar(args = {}) {
  const today = chicagoYmd();
  const todayLabel = `${weekdayName(today)}, ${today}`;
  const phrase = args.phrase != null ? String(args.phrase).trim().toLowerCase() : '';
  const single = args.date != null ? String(args.date).trim() : '';
  const list = Array.isArray(args.dates) ? args.dates.map((x) => String(x).trim()) : [];
  const resolved = [];
  const push = (ymd, note) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return;
    resolved.push({
      date: ymd,
      weekday: weekdayName(ymd),
      label: `${weekdayName(ymd)}, ${ymd}`,
      note: note || null,
    });
  };
  if (phrase) {
    const wantsFri = /friday/.test(phrase);
    const wantsSat = /saturday/.test(phrase);
    const wantsSun = /sunday/.test(phrase);
    const twoWeeks = /two weeks|2 weeks|in two weeks/.test(phrase);
    const next = /\bnext\b/.test(phrase);
    const this_ = /\bthis\b/.test(phrase);
    const targetWd = wantsFri ? 5 : wantsSat ? 6 : wantsSun ? 0 : null;
    if (targetWd != null) {
      let ymd;
      if (twoWeeks) {
        const first = nextWeekdayOnOrAfter(today, targetWd, { skipTodayIfMatch: false });
        ymd = addDaysYmd(first, 14);
      } else if (next) {
        const nearest = nextWeekdayOnOrAfter(today, targetWd, { skipTodayIfMatch: false });
        ymd = addDaysYmd(nearest, 7);
      } else if (this_) {
        ymd = nextWeekdayOnOrAfter(today, targetWd, { skipTodayIfMatch: false });
      } else {
        ymd = nextWeekdayOnOrAfter(today, targetWd, { skipTodayIfMatch: false });
      }
      push(ymd, phrase);
    }
  }
  if (single) push(single, 'date');
  for (const d of list) push(d, 'dates');
  const thisFri = nextWeekdayOnOrAfter(today, 5);
  const nextFri = addDaysYmd(thisFri, 7);
  const thisSat = nextWeekdayOnOrAfter(today, 6);
  const nextSat = addDaysYmd(thisSat, 7);
  const spoken =
    resolved.length > 0
      ? `Use these dates: ${resolved.map((r) => r.label).join('; ')}.`
      : `Anchors: this Friday ${thisFri}, next Friday ${nextFri}, this Saturday ${thisSat}, next Saturday ${nextSat}.`;
  const result = {
    ok: true,
    timezone: 'America/Chicago',
    today: { date: today, weekday: weekdayName(today), label: todayLabel },
    anchors: {
      thisFriday: { date: thisFri, weekday: weekdayName(thisFri) },
      nextFriday: { date: nextFri, weekday: weekdayName(nextFri) },
      thisSaturday: { date: thisSat, weekday: weekdayName(thisSat) },
      nextSaturday: { date: nextSat, weekday: weekdayName(nextSat) },
    },
    resolved,
    spokenSummary: spoken,
  };
  logTool('resolve_calendar', args, result);
  return result;
}

export async function end_call(args = {}) {
  fs.mkdirSync(config.transcriptsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ctx = getCallContext();
  const callSessionId = ctx?.callSessionId || args.session_id || 'local';
  const id = String(callSessionId).replace(/[^\w.-]/g, '_').slice(0, 64);
  const base = `call_${stamp}_${id}`;
  const summaryPath = path.join(config.transcriptsDir, `${base}.summary.txt`);
  const transcriptPath = path.join(config.transcriptsDir, `${base}.transcript.txt`);
  const summary = args.summary || '';
  const transcript = args.transcript || '';
  fs.writeFileSync(summaryPath, summary, 'utf8');
  fs.writeFileSync(transcriptPath, transcript, 'utf8');

  let telegram = { skipped: true };
  const notify = args.notify_jason !== false && summary.trim().length > 0;
  if (notify) {
    telegram = await notifyJason(
      `📞 JV Assistant call ended\nFrom: ${args.caller_name || 'unknown'} <${args.caller_phone || ctx?.from || 'unknown'}>\nSummary: ${summary.slice(0, 1500)}`
    );
  }

  const result = {
    ok: true,
    files: { summary: summaryPath, transcript: transcriptPath },
    telegram,
    hangup: ctx?.channel === 'pstn' ? 'twilio_after_playback' : 'close',
    callSessionId,
  };
  logTool('end_call', { ...args, transcript: transcript ? `[len=${transcript.length}]` : '' }, result);
  return result;
}

export const handlers = {
  transfer_to_jason,
  save_message_for_jason,
  web_search,
  resolve_calendar,
  end_call,
};

export async function runTool(name, args) {
  const fn = handlers[name];
  if (!fn) return { ok: false, error: `Unknown tool: ${name}` };
  const ctx = getCallContext();
  const merged = { ...(args || {}) };
  if (ctx?.channel === 'pstn' && ctx.from) {
    if (name === 'transfer_to_jason' && !merged.caller_phone) merged.caller_phone = ctx.from;
    if (name === 'save_message_for_jason' && !merged.caller_phone) merged.caller_phone = ctx.from;
    if (name === 'end_call' && !merged.caller_phone) merged.caller_phone = ctx.from;
  }
  return fn(merged);
}
