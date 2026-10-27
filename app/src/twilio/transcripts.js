import { retentionCutoffMs, tokenize } from '../time.js';
import {
  intelligenceSentencesUrl,
  intelligenceTranscriptsUrl,
  recordingMediaUrl,
  recordingTranscriptionsUrl,
  recordingsForCallUrl,
  twilioBasicAuth,
  twilioRequest,
  callsUrl,
} from './rest.js';

/**
 * Search already-fetched transcript records (pure — used by tests).
 * @param {Array<{callSid:string, dateCreated:string, text:string, recordingSid?:string}>} records
 */
export function searchTranscriptRecords(records, { query, now = new Date(), sinceDays = 60, limit = 8 } = {}) {
  const cutoff = retentionCutoffMs(now instanceof Date ? now : new Date(now), sinceDays);
  const tokens = tokenize(query);
  const phrase = String(query || '').toLowerCase().trim();
  const windowed = (records || []).filter((r) => {
    const ts = Date.parse(r.dateCreated || r.date || '');
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const scored = windowed
    .map((r) => {
      const text = String(r.text || '').toLowerCase();
      let score = 0;
      if (!phrase) score = 1;
      else {
        for (const t of tokens) if (text.includes(t)) score += 1;
        if (phrase.length >= 4 && text.includes(phrase)) score += 3;
      }
      if (!score) return null;
      const idx = phrase ? text.indexOf(tokens[0] || phrase) : 0;
      const start = Math.max(0, idx - 80);
      const snippet = String(r.text || '').slice(start, start + 240);
      return { score, record: r, snippet };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || String(b.record.dateCreated).localeCompare(String(a.record.dateCreated)))
    .slice(0, limit);

  return {
    ok: true,
    query: phrase || null,
    sinceDays,
    matchCount: scored.length,
    matches: scored.map(({ score, record, snippet }) => ({
      score,
      callSid: record.callSid || null,
      dateCreated: record.dateCreated || null,
      recordingSid: record.recordingSid || null,
      source: record.source || null,
      snippet,
    })),
  };
}

function sentencesToText(sentences) {
  if (!Array.isArray(sentences)) return '';
  return sentences
    .map((s) => {
      const who = s.media_channel === 1 || s.mediaChannel === 1 ? 'callee' : 'caller';
      const text = s.transcript || s.text || '';
      return text ? `${who}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

async function fetchIntelligenceTranscript({ accountSid, authToken, serviceSid, callSid, recordingSid, fetchImpl }) {
  if (!serviceSid) return null;
  const params = new URLSearchParams({ ServiceSid: serviceSid, PageSize: '20' });
  if (recordingSid) params.set('SourceSid', recordingSid);
  const list = await twilioRequest({
    accountSid,
    authToken,
    url: `${intelligenceTranscriptsUrl()}?${params}`,
    fetchImpl,
  });
  if (!list.ok) return null;
  const transcripts = list.body.transcripts || list.body.Transcripts || [];
  const match =
    transcripts.find((t) => {
      const source = t.channel?.media_properties?.source_sid || t.source_sid;
      return (recordingSid && source === recordingSid) || (callSid && (t.sid === callSid || source === callSid));
    }) || transcripts[0];
  if (!match?.sid) return null;
  const sent = await twilioRequest({
    accountSid,
    authToken,
    url: `${intelligenceSentencesUrl(match.sid)}?PageSize=200`,
    fetchImpl,
  });
  const sentences = sent.body.sentences || sent.body.Sentences || [];
  const text = sentencesToText(sentences);
  if (!text) return null;
  return { text, source: 'voice_intelligence', transcriptSid: match.sid };
}

async function fetchRecordingTranscription({ accountSid, authToken, recordingSid, fetchImpl }) {
  const res = await twilioRequest({
    accountSid,
    authToken,
    url: recordingTranscriptionsUrl(accountSid, recordingSid),
    fetchImpl,
  });
  if (!res.ok) return null;
  const rows = res.body.transcriptions || [];
  const done = rows.find((t) => String(t.status || '').toLowerCase() === 'completed' && t.transcription_text);
  if (!done) return null;
  return { text: String(done.transcription_text), source: 'recording_transcription', transcriptionSid: done.sid };
}

async function transcribeRecordingAudio({
  accountSid,
  authToken,
  openaiApiKey,
  recordingSid,
  fetchImpl,
}) {
  if (!openaiApiKey || !recordingSid) return null;
  const mediaUrl = recordingMediaUrl(accountSid, recordingSid, 'mp3');
  try {
    const audioRes = await fetchImpl(mediaUrl, {
      headers: { Authorization: twilioBasicAuth(accountSid, authToken) },
    });
    if (!audioRes.ok) return null;
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (!buf.length) return null;
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'recording.mp3');
    form.append('model', 'whisper-1');
    const tr = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiApiKey}` },
      body: form,
    });
    const data = await tr.json().catch(() => ({}));
    const text = String(data.text || '').trim();
    if (!text) return null;
    return { text, source: 'openai_whisper' };
  } catch {
    return null;
  }
}

export async function listRecentCalls({
  accountSid,
  authToken,
  pageSize = 20,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = `${callsUrl(accountSid)}?PageSize=${encodeURIComponent(String(pageSize))}`;
  const res = await twilioRequest({ accountSid, authToken, url, fetchImpl });
  if (!res.ok) {
    return { ok: false, error: res.error || 'twilio_list_failed', status: res.status, calls: [] };
  }
  const calls = (res.body.calls || []).map((c) => ({
    sid: c.sid,
    from: c.from,
    to: c.to,
    status: c.status,
    direction: c.direction,
    startTime: c.start_time || c.date_created,
    endTime: c.end_time || null,
    duration: c.duration || null,
  }));
  return { ok: true, calls };
}

export async function listRecordingsForCall({ accountSid, authToken, callSid, fetchImpl = globalThis.fetch } = {}) {
  const res = await twilioRequest({
    accountSid,
    authToken,
    url: recordingsForCallUrl(accountSid, callSid),
    fetchImpl,
  });
  if (!res.ok) return [];
  return res.body.recordings || [];
}

/**
 * Fetch a call's transcript: Voice Intelligence → Twilio recording transcription → Whisper on Twilio audio.
 * Does not start a new recording.
 */
export async function fetchCallTranscript({
  accountSid,
  authToken,
  openaiApiKey,
  intelligenceServiceSid,
  callSid,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!callSid) return { ok: false, error: 'missing_call_sid' };
  const recordings = await listRecordingsForCall({ accountSid, authToken, callSid, fetchImpl });
  const recordingSid = recordings[0]?.sid || null;

  const intel = await fetchIntelligenceTranscript({
    accountSid,
    authToken,
    serviceSid: intelligenceServiceSid,
    callSid,
    recordingSid,
    fetchImpl,
  });
  if (intel) {
    return { ok: true, callSid, recordingSid, ...intel };
  }

  if (recordingSid) {
    const twilioTr = await fetchRecordingTranscription({
      accountSid,
      authToken,
      recordingSid,
      fetchImpl,
    });
    if (twilioTr) return { ok: true, callSid, recordingSid, ...twilioTr };

    const whisper = await transcribeRecordingAudio({
      accountSid,
      authToken,
      openaiApiKey,
      recordingSid,
      fetchImpl,
    });
    if (whisper) return { ok: true, callSid, recordingSid, ...whisper };
  }

  return {
    ok: false,
    error: 'transcript_unavailable',
    callSid,
    recordingSid,
    agent_hint:
      recordingSid
        ? 'Twilio recorded this call but no transcript is ready yet. Try again in a minute, or set TWILIO_VOICE_INTELLIGENCE_SID.'
        : 'No Twilio recording found for this CallSid. Confirm account-level or call Record is enabled — this service does not add a second recorder.',
  };
}

export async function searchCallTranscripts({
  accountSid,
  authToken,
  openaiApiKey,
  intelligenceServiceSid,
  query,
  sinceDays = 60,
  now = new Date(),
  limit = 8,
  maxCalls = 15,
  fetchImpl = globalThis.fetch,
} = {}) {
  const listed = await listRecentCalls({ accountSid, authToken, pageSize: maxCalls, fetchImpl });
  if (!listed.ok) return { ok: false, error: listed.error, matches: [] };

  const records = [];
  for (const call of listed.calls) {
    const fetched = await fetchCallTranscript({
      accountSid,
      authToken,
      openaiApiKey,
      intelligenceServiceSid,
      callSid: call.sid,
      fetchImpl,
    });
    if (fetched.ok && fetched.text) {
      records.push({
        callSid: call.sid,
        dateCreated: call.startTime || call.endTime || new Date().toISOString(),
        text: fetched.text,
        recordingSid: fetched.recordingSid || null,
        source: fetched.source,
      });
    }
  }
  return searchTranscriptRecords(records, { query, now, sinceDays, limit });
}
