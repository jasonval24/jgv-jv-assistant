import { config } from '../config.js';
import { evaluatePhoneConsent, resolveActor, targetKindForNumber } from '../consent.js';
import { ART_TWILIO_DID_E164, PROTECTED_LEADCONNECTOR_E164, normalizeE164 } from '../twilio/numbers.js';
import { callsUrl, messagesUrl, twilioConfigured, twilioRequest } from '../twilio/rest.js';
import { getJob, patchJob, putJob } from './jobs.js';

const lastActionAt = new Map();
const RATE_MS = 15_000;

function rateKey(action, to) {
  return `${action}:${normalizeE164(to) || to || '?'}`;
}

function rateLimited(action, to) {
  const key = rateKey(action, to);
  const wait = (lastActionAt.get(key) || 0) + RATE_MS - Date.now();
  if (wait > 0) return { limited: true, retryAfterS: Math.ceil(wait / 1000) };
  lastActionAt.set(key, Date.now());
  return { limited: false };
}

export function isBlockedDestination(phone) {
  const n = normalizeE164(phone);
  return n === PROTECTED_LEADCONNECTOR_E164 || n === ART_TWILIO_DID_E164;
}

export function consentForPhoneAction({
  actor,
  action,
  to,
  jasonCell,
  explicitInCurrentConversation,
  reminderAuthorized,
  purpose,
}) {
  const dest = normalizeE164(to);
  if (!dest) return { allowed: false, reason: 'invalid_destination' };
  if (isBlockedDestination(dest)) return { allowed: false, reason: 'protected_number' };
  return evaluatePhoneConsent({
    actor,
    action,
    targetKind: targetKindForNumber({ to: dest, jasonCell, normalize: normalizeE164 }),
    explicitInCurrentConversation,
    reminderAuthorized,
    purpose,
  });
}

function requireTwilioAndBase(publicBase) {
  if (!twilioConfigured({ accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken })) {
    return { ok: false, error: 'twilio_not_configured' };
  }
  const from = normalizeE164(config.twilioVoiceNumber);
  if (!from) return { ok: false, error: 'twilio_voice_number_unset' };
  if (!publicBase) return { ok: false, error: 'public_base_unset' };
  return { ok: true, from, publicBase: String(publicBase).replace(/\/$/, '') };
}

/**
 * Send SMS from the JV DID. Consent must already have been checked by the caller
 * (or pass consent fields and this function will check).
 */
export async function sendSms({
  to,
  body,
  actor,
  jasonCell,
  explicitInCurrentConversation,
  reminderAuthorized,
  reminderId,
  skipConsent = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const dest = normalizeE164(to);
  const text = String(body || '').trim().slice(0, 1500);
  if (!dest) return { ok: false, error: 'invalid_destination' };
  if (!text) return { ok: false, error: 'missing_body' };
  if (!skipConsent) {
    const gate = consentForPhoneAction({
      actor,
      action: 'sms',
      to: dest,
      jasonCell: jasonCell || config.jasonCell,
      explicitInCurrentConversation,
      reminderAuthorized,
      purpose: reminderAuthorized ? 'reminder' : 'conversation',
    });
    if (!gate.allowed) {
      return { ok: false, error: 'consent_denied', reason: gate.reason, reminderId: reminderId || null };
    }
  }
  if (isBlockedDestination(dest)) return { ok: false, error: 'protected_number' };
  const cfg = requireTwilioAndBase(config.publicBaseUrl || 'https://local.test');
  if (!cfg.ok && cfg.error === 'twilio_not_configured') return cfg;
  if (!twilioConfigured({ accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken })) {
    return { ok: false, error: 'twilio_not_configured' };
  }
  const from = normalizeE164(config.twilioVoiceNumber);
  if (!from) return { ok: false, error: 'twilio_voice_number_unset' };
  const limited = rateLimited('sms', dest);
  if (limited.limited) return { ok: false, error: 'rate_limited', retry_after_s: limited.retryAfterS };

  const res = await twilioRequest({
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
    url: messagesUrl(config.twilioAccountSid),
    method: 'POST',
    body: { To: dest, From: from, Body: text },
    fetchImpl,
  });
  if (!res.ok) {
    return { ok: false, error: 'twilio_sms_failed', status: res.status, message: res.body?.message || null };
  }
  return {
    ok: true,
    sid: res.body.sid || null,
    to: dest,
    from,
    reminderId: reminderId || null,
    agent_hint: 'SMS sent from the JV line. Confirm briefly to Jason. Do not read the SID aloud.',
  };
}

/**
 * Place an outbound call from the JV DID.
 * purpose: deliver_message | conversation | escalate | reminder
 */
export async function placeOutboundPhoneCall({
  store,
  to,
  message,
  instructions,
  purpose = 'deliver_message',
  actor,
  jasonCell,
  explicitInCurrentConversation,
  reminderAuthorized,
  reminderId,
  publicBase,
  skipConsent = false,
  fetchImpl = globalThis.fetch,
  registerRealtime,
} = {}) {
  const dest = normalizeE164(to);
  if (!dest) return { ok: false, error: 'invalid_destination' };
  if (!skipConsent) {
    const gate = consentForPhoneAction({
      actor,
      action: 'call',
      to: dest,
      jasonCell: jasonCell || config.jasonCell,
      explicitInCurrentConversation,
      reminderAuthorized,
      purpose,
    });
    if (!gate.allowed) {
      return { ok: false, error: 'consent_denied', reason: gate.reason };
    }
  }
  if (isBlockedDestination(dest)) return { ok: false, error: 'protected_number' };
  const base = publicBase || config.publicBaseUrl;
  const cfg = requireTwilioAndBase(base);
  if (!cfg.ok) return cfg;

  const limited = rateLimited('call', dest);
  if (limited.limited) return { ok: false, error: 'rate_limited', retry_after_s: limited.retryAfterS };

  const job = putJob(store, {
    kind: purpose === 'conversation' || purpose === 'escalate' ? 'realtime' : 'deliver',
    purpose,
    to: dest,
    message: String(message || '').trim().slice(0, 4000),
    instructions: String(instructions || '').trim().slice(0, 4000),
    reminderId: reminderId || null,
    callStatus: 'queued',
  });

  let url;
  if (job.kind === 'realtime' && typeof registerRealtime === 'function') {
    const token = registerRealtime({
      who: purpose === 'escalate' || purpose === 'reminder' ? 'jason' : 'custom',
      name: purpose === 'escalate' || purpose === 'reminder' ? 'Jason Valenzuela' : dest,
      to: dest,
      message: job.message,
      instructions: job.instructions,
      purpose,
      token: job.token,
    });
    url = `${cfg.publicBase}/twilio/voice?ob=${encodeURIComponent(token || job.token)}`;
  } else {
    url = `${cfg.publicBase}/twilio/deliver?tok=${encodeURIComponent(job.token)}`;
  }

  const form = {
    To: dest,
    From: cfg.from,
    Url: url,
    Method: 'POST',
    StatusCallback: `${cfg.publicBase}/twilio/status`,
    StatusCallbackMethod: 'POST',
    MachineDetection: 'Enable',
    AsyncAmd: 'true',
    AsyncAmdStatusCallback: `${cfg.publicBase}/twilio/status`,
    Timeout: '25',
    TimeLimit: '600',
  };
  const targetKind = targetKindForNumber({ to: dest, jasonCell: jasonCell || config.jasonCell, normalize: normalizeE164 });
  if (targetKind === 'third_party') {
    form.Record = 'true';
    form.RecordingStatusCallback = `${cfg.publicBase}/twilio/recording`;
    form.RecordingStatusCallbackMethod = 'POST';
  }

  const res = await twilioRequest({
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
    url: callsUrl(config.twilioAccountSid),
    method: 'POST',
    body: form,
    fetchImpl,
  });
  if (!res.ok) {
    patchJob(store, job.token, { callStatus: 'failed', lastError: 'twilio_error' });
    return { ok: false, error: 'twilio_call_failed', status: res.status, message: res.body?.message || null };
  }
  patchJob(store, job.token, { callSid: res.body.sid, callStatus: res.body.status || 'queued' });
  return {
    ok: true,
    callSid: res.body.sid || null,
    status: res.body.status || null,
    token: job.token,
    to: dest,
    purpose,
    from: cfg.from,
    recorded: targetKind === 'third_party',
    agent_hint:
      purpose === 'deliver_message'
        ? 'Call placed. After it finishes I will report answered, voicemail, no answer, and any reply. Do not invent an outcome.'
        : 'Call placed from the JV line. Wait for the result before claiming they picked up.',
  };
}

export function applyCallStatusToJob(store, { callSid, token, callStatus, answeredBy }) {
  const job = token ? getJob(store, token) : getJobByCallSidSafe(store, callSid);
  if (!job) return null;
  const fields = {};
  if (callStatus) fields.callStatus = callStatus;
  if (answeredBy) fields.answeredBy = answeredBy;
  if (callSid && !job.callSid) fields.callSid = callSid;
  return patchJob(store, job.token, fields);
}

function getJobByCallSidSafe(store, callSid) {
  if (!callSid || !store) return null;
  const data = store.read();
  return Object.values(data?.jobs || {}).find((j) => j.callSid === callSid) || null;
}

export { resolveActor, getJobByCallSidSafe as getJobByCallSid };
