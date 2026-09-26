import { config, redact } from '../config.js';
import { maskPhone, normalizeE164 } from './numbers.js';

const PHONE_KEYS = /(phone|^from$|^to$|callerid|caller_id)/i;

function maskPhones(value, key) {
  if (typeof value === 'string' && key && PHONE_KEYS.test(key) && normalizeE164(value)) {
    return maskPhone(value);
  }
  if (Array.isArray(value)) return value.map((item) => maskPhones(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskPhones(v, k);
    return out;
  }
  return value;
}

export function redactForLog(entry) {
  return maskPhones(redact(entry));
}

export function logEvent(event, fields = {}) {
  const line = redactForLog({
    ts: new Date().toISOString(),
    service: config.serviceName,
    event,
    ...fields,
  });
  console.log(JSON.stringify(line));
  return line;
}
