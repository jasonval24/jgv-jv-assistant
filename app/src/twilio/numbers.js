/** Published GHL LeadConnector — never dial/reconfigure from this service either. */
export const PROTECTED_LEADCONNECTOR_E164 = '+13616008508';

/** Art pilot DID — do not reconfigure from this service. */
export const ART_TWILIO_DID_E164 = '+13613360871';

/** JV Assistant personal DID (McAllen 956). */
export const JV_TWILIO_DID_E164 = '+19564684455';

/** Jason transfer / escalate target — reads env each call, never a hardcoded cell. */
export function jasonCellE164() {
  return normalizeE164(process.env.JASON_CELL || process.env.TRANSFER_TO_JASON || '');
}

/** @deprecated Prefer jasonCellE164() so tests/env updates are live. */
export const TRANSFER_TARGET_E164 = jasonCellE164();

export function isJasonCaller(phone) {
  const jason = jasonCellE164();
  const n = normalizeE164(phone);
  return Boolean(jason && n && jason === n);
}

/** Alias used by transfer.js for caller-id fallback. */
export const PILOT_TWILIO_DID_E164 = JV_TWILIO_DID_E164;

export function normalizeE164(phone) {
  if (phone == null || phone === '') return null;
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

export function isProtectedLeadConnector(phone) {
  return normalizeE164(phone) === PROTECTED_LEADCONNECTOR_E164;
}

export function isArtDid(phone) {
  return normalizeE164(phone) === ART_TWILIO_DID_E164;
}

export function callSessionIdForCallSid(callSid) {
  const sid = String(callSid || '').trim();
  if (!/^CA[0-9a-fA-F]{32}$/.test(sid)) return null;
  return `jv_${sid}`;
}

export function isTwilioCallSid(callSid) {
  return callSessionIdForCallSid(callSid) != null;
}

export function maskPhone(phone) {
  const e164 = normalizeE164(phone);
  if (!e164) return null;
  return `${e164.slice(0, 2)}******${e164.slice(-4)}`;
}
