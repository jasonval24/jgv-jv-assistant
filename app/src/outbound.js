// Outbound "family" calls: Grok Bot asks this service to ring a family member (Anna; later Jason)
// and connect them to the Realtime agent seeded with a message + group-chat context.
import crypto from 'crypto';
import { config } from './config.js';

const TTL_MS = 30 * 60 * 1000;
const RATE_MS = 2 * 60 * 1000;
const registry = new Map(); // token -> record
const lastCallAt = new Map(); // who -> ms

export const RECIPIENTS = {
  anna: { name: 'Anna Valenzuela', phone: () => process.env.ANNA_PHONE || '', enabled: () => (process.env.ANNA_CALLS || 'on').toLowerCase() !== 'off' },
  jason: { name: 'Jason Valenzuela', phone: () => config.jasonCell, enabled: () => (process.env.JASON_OUTBOUND_CALLS || 'off').toLowerCase() === 'on' },
};

setInterval(() => { const n = Date.now(); for (const [k, v] of registry) if (v.exp < n) registry.delete(k); }, 60000).unref();

export function getOutbound(token) { const r = token && registry.get(token); return r && r.exp > Date.now() ? r : null; }

function clip(s, n) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }

export function buildFamilyInstructions(rec) {
  const thread = (rec.thread || []).slice(-12).map((m) => `- ${clip(m.from || '?', 40)}: ${clip(m.text, 400)}`).join('\n') || '(none provided)';
  const now = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  const isAnna = rec.who === 'anna';
  return `# ROLE
You are Grokberto, Jason Valenzuela's personal assistant, placing an OUTBOUND phone call to ${rec.name}${isAnna ? " (Jason's wife; family)" : ''}.
It is ${now} (America/Chicago; never say the time zone aloud).
Talk like a warm, natural person on the phone: short sentences, one idea at a time, let them interrupt, no lists read aloud, no markdown, no URLs (say "I put the link in the group chat").

# WHY YOU ARE CALLING (deliver this first, in your own words)
${clip(rec.message, 3000)}

# RECENT FAMILY GROUP CHAT (Telegram "JV AV Asst Bot Chat"; context only)
${thread}

# OPENING
First words: "Hi ${isAnna ? 'Anna' : 'Jason'}, it's Grokberto, Jason's assistant." Then go straight into the message. Do not ask "can you hear me".
If you hear a voicemail greeting, a beep, or a call-screening prompt asking your name and reason: say once, briefly, "This is Grokberto, Jason's assistant, with a message for ${isAnna ? 'Anna' : 'Jason'}", give a one or two sentence version of the message, say it's also in the group chat, then call end_call. Never chat with a machine.

# FOLLOW-UP QUESTIONS
Answer naturally from the message and chat context above. Use resolve_calendar for date math and web_search for public facts (weather, traffic, addresses, hours) when useful.
If you don't know something (Jason's private calendar, plans not in the context), say so honestly and say you'll pass the question to Jason. Never invent details.
${isAnna ? `# LIMITS FOR THIS CALLER
Family-level only: no business, client, tax, audit, or financial/account details for any of Jason's companies.
Do not book, buy, cancel, send emails/texts, or commit Jason to anything. If she asks for an action, say you'll pass it to Jason for his OK.` : ''}

# ENDING
When the conversation wraps up (or they say bye), say a short goodbye and call end_call with a 1-3 sentence summary and any requests for Jason. Keep the whole call short unless they want to talk.`;
}

export const FAMILY_TOOL_NAMES = new Set(['web_search', 'resolve_calendar', 'end_call']);

export async function placeOutboundCall({ who, message, thread, publicBase }) {
  const rcp = RECIPIENTS[who];
  if (!rcp) return { status: 400, body: { ok: false, error: 'unknown_recipient', allowed: Object.keys(RECIPIENTS) } };
  if (!rcp.enabled()) return { status: 200, body: { ok: false, reason: `${who}_calls_off` } };
  const to = rcp.phone();
  if (!to) return { status: 503, body: { ok: false, error: 'recipient_phone_unset' } };
  const wait = (lastCallAt.get(who) || 0) + RATE_MS - Date.now();
  if (wait > 0) return { status: 429, body: { ok: false, reason: 'rate_limited', retry_after_s: Math.ceil(wait / 1000) } };
  if (!config.twilioAccountSid || !config.twilioAuthToken || !publicBase) return { status: 503, body: { ok: false, error: 'twilio_or_public_base_unset' } };
  const token = crypto.randomBytes(12).toString('hex');
  const rec = { token, who, name: rcp.name, to, message, thread, transcript: [], created: Date.now(), exp: Date.now() + TTL_MS };
  registry.set(token, rec);
  lastCallAt.set(who, Date.now());
  const form = new URLSearchParams({
    To: to, From: config.twilioVoiceNumber,
    Url: `${publicBase}/twilio/voice?ob=${token}`, Method: 'POST',
    StatusCallback: `${publicBase}/twilio/status`, StatusCallbackMethod: 'POST',
    MachineDetection: 'Enable', AsyncAmd: 'true', AsyncAmdStatusCallback: `${publicBase}/twilio/status`,
    Timeout: '25', TimeLimit: '900',
  });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { registry.delete(token); lastCallAt.delete(who); return { status: 502, body: { ok: false, error: 'twilio_error', message: j.message } }; }
  rec.callSid = j.sid;
  return { status: 200, body: { ok: true, callSid: j.sid, status: j.status } };
}

export function previewOutbound({ who, message, thread }) {
  const rcp = RECIPIENTS[who];
  if (!rcp) return { ok: false, error: 'unknown_recipient' };
  const rec = { who, name: rcp.name, message, thread };
  return { ok: true, dry_run: true, who, enabled: rcp.enabled(), phone_set: Boolean(rcp.phone()), instructions: buildFamilyInstructions(rec), tools: [...FAMILY_TOOL_NAMES] };
}

/** After hangup: summarize transcript and POST to the Grok Bot routine webhook. */
export async function reportOutboundCall(rec, { endSummary, reason } = {}) {
  if (!rec || rec.reported) return; rec.reported = true;
  const transcript = rec.transcript.map((t) => `${t.role === 'user' ? rec.name.split(' ')[0] : 'Grokberto'}: ${t.text}`).join('\n').slice(0, 12000);
  let summary = endSummary || '', requests_for_jason = [], reached = rec.transcript.some((t) => t.role === 'user');
  if (transcript && config.openaiApiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.openaiChatModel, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: 'Summarize this phone call for Jason. Return JSON {"summary": "2-4 short sentences", "requests_for_jason": ["..."], "reached_human": true|false}. reached_human is false if it was voicemail/screening/no human.' },
          { role: 'user', content: `Message delivered: ${rec.message}\n\nTranscript:\n${transcript}` } ] }),
      });
      const j = await r.json(); const o = JSON.parse(j.choices?.[0]?.message?.content || '{}');
      summary = o.summary || summary; requests_for_jason = Array.isArray(o.requests_for_jason) ? o.requests_for_jason : []; if (typeof o.reached_human === 'boolean') reached = o.reached_human;
    } catch { /* keep fallbacks */ }
  }
  const url = process.env.ROUTINE_URL, key = process.env.ROUTINE_KEY;
  if (!url) return;
  const payload = { source: `${rec.who}_call_summary`, who: rec.who, call_sid: rec.callSid, reached_human: reached, answered_by: rec.answeredBy || null, end_reason: reason || null,
    message_delivered: rec.message, summary: summary || (transcript ? '' : 'No conversation (unanswered, voicemail, or hung up).'), requests_for_jason, transcript };
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(payload) }).catch(() => {});
}
