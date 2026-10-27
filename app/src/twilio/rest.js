/**
 * Twilio REST helpers. Never log the auth token or Authorization header.
 */

export function twilioBasicAuth(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

export function twilioConfigured({ accountSid, authToken }) {
  return Boolean(accountSid && authToken && /^AC[0-9a-fA-F]{32}$/.test(accountSid));
}

export async function twilioRequest({
  accountSid,
  authToken,
  url,
  method = 'GET',
  body,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!twilioConfigured({ accountSid, authToken })) {
    return { ok: false, status: 0, body: {}, error: 'twilio_not_configured' };
  }
  const headers = { Authorization: twilioBasicAuth(accountSid, authToken) };
  let payload;
  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = body;
  } else if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body);
  }
  try {
    const res = await fetchImpl(url, { method, headers, body: payload, signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, body: {}, error: 'network', message: err?.message || 'network_error' };
  }
}

export function callsUrl(accountSid, callSid) {
  const root = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
  return callSid ? `${root}/Calls/${callSid}.json` : `${root}/Calls.json`;
}

export function messagesUrl(accountSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
}

export function recordingsForCallUrl(accountSid, callSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json`;
}

export function recordingTranscriptionsUrl(accountSid, recordingSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}/Transcriptions.json`;
}

export function recordingMediaUrl(accountSid, recordingSid, ext = 'mp3') {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.${ext}`;
}

export function intelligenceTranscriptsUrl(sid) {
  return sid
    ? `https://intelligence.twilio.com/v2/Transcripts/${sid}`
    : 'https://intelligence.twilio.com/v2/Transcripts';
}

export function intelligenceSentencesUrl(transcriptSid) {
  return `https://intelligence.twilio.com/v2/Transcripts/${transcriptSid}/Sentences`;
}
