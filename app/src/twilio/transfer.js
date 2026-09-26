import { config } from '../config.js';
import { logEvent } from './log.js';
import {
  PILOT_TWILIO_DID_E164,
  PROTECTED_LEADCONNECTOR_E164,
  isProtectedLeadConnector,
  isTwilioCallSid,
  normalizeE164,
} from './numbers.js';
import { buildDialTwiml, dialActionUrl } from './twiml.js';

const FAILURE_HINT =
  'The transfer to Jason failed. Apologize once and tell the caller Jason will call them back. Do not claim they are connected.';

export function transferDestination() {
  const configured = normalizeE164(config.transferToJason);
  if (!configured || configured === PROTECTED_LEADCONNECTOR_E164) return null;
  return configured;
}

export function transferCallerId() {
  const configured = normalizeE164(config.twilioVoiceNumber);
  if (configured && configured !== PROTECTED_LEADCONNECTOR_E164) return configured;
  return PILOT_TWILIO_DID_E164;
}

function twilioAuthHeader() {
  const raw = `${config.twilioAccountSid}:${config.twilioAuthToken}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function callUrl(callSid) {
  return `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Calls/${callSid}.json`;
}

/**
 * Update the live Twilio call so it dials Jason.
 * Never calls the IncomingPhoneNumbers API and never dials +13616008508.
 */
export async function transferLiveCall(callSid, _requestedTo, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const destination = transferDestination();
  if (!destination) {
    return {
      ok: false,
      error: 'invalid_transfer_target',
      agent_hint: FAILURE_HINT,
    };
  }
  if (isProtectedLeadConnector(_requestedTo) || isProtectedLeadConnector(destination)) {
    logEvent('transfer_blocked_protected_number', { callSid: callSid || null });
    return {
      ok: false,
      error: 'protected_number',
      agent_hint: FAILURE_HINT,
    };
  }
  if (!callSid) {
    return {
      ok: false,
      error: 'not_pstn_call',
      action: 'transfer',
      to: destination,
      agent_hint:
        'This is not a live phone call. Tell the caller Jason will call them back. Do not claim they are being transferred.',
    };
  }
  if (!isTwilioCallSid(callSid)) {
    return {
      ok: false,
      error: 'invalid_call_sid',
      agent_hint: FAILURE_HINT,
    };
  }
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    return {
      ok: false,
      error: 'twilio_not_configured',
      to: destination,
      agent_hint: FAILURE_HINT,
    };
  }
  if (!/^AC[0-9a-fA-F]{32}$/.test(config.twilioAccountSid)) {
    return {
      ok: false,
      error: 'invalid_account_sid',
      agent_hint: FAILURE_HINT,
    };
  }

  const callerId = transferCallerId();
  const twiml = buildDialTwiml({
    to: destination,
    callerId,
    actionUrl: dialActionUrl(),
  });
  const url = callUrl(callSid);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Twiml: twiml }),
    });
    if (!res.ok) {
      logEvent('transfer_failed', { callSid, status: res.status });
      return {
        ok: false,
        error: 'twilio_transfer_failed',
        status: res.status,
        to: destination,
        agent_hint: FAILURE_HINT,
      };
    }
    logEvent('transfer_started', { callSid, to: destination, callerId });
    return {
      ok: true,
      action: 'transfer',
      to: destination,
      callerId,
      status: res.status,
    };
  } catch (err) {
    logEvent('transfer_failed', { callSid, error: 'network', message: err?.message || 'network_error' });
    return {
      ok: false,
      error: 'twilio_transfer_failed',
      to: destination,
      agent_hint: FAILURE_HINT,
    };
  }
}

/** Complete the Twilio call after Art has finished the goodbye. */
export async function hangupLiveCall(callSid, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (!callSid || !isTwilioCallSid(callSid)) {
    return { ok: false, error: 'not_pstn_call' };
  }
  if (!config.twilioAccountSid || !config.twilioAuthToken) {
    return { ok: false, error: 'twilio_not_configured' };
  }
  try {
    const res = await fetchImpl(callUrl(callSid), {
      method: 'POST',
      headers: {
        Authorization: twilioAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Status: 'completed' }),
    });
    logEvent('hangup_requested', { callSid, status: res.status, ok: res.ok });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    logEvent('hangup_requested', { callSid, ok: false, error: 'network' });
    return { ok: false, error: 'network', message: err?.message || 'network_error' };
  }
}
