import crypto from 'node:crypto';

/**
 * Twilio signs the full URL plus sorted POST params with HMAC-SHA1 (base64).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function computeTwilioSignature(authToken, url, params = {}) {
  const keys = Object.keys(params).sort();
  let data = String(url);
  for (const key of keys) {
    const value = params[key];
    if (value == null) continue;
    data += key + String(value);
  }
  return crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function twilioSignatureIsValid({ authToken, signature, urls, params }) {
  if (!authToken || !signature || !urls?.length) return false;
  const provided = Buffer.from(String(signature));
  for (const url of urls) {
    const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
    if (expected.length !== provided.length) continue;
    if (crypto.timingSafeEqual(expected, provided)) return true;
  }
  return false;
}

function swapScheme(url) {
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  if (url.startsWith('wss://')) return `https://${url.slice('wss://'.length)}`;
  if (url.startsWith('ws://')) return `http://${url.slice('ws://'.length)}`;
  return null;
}

/**
 * Candidate URLs Twilio may have signed. PUBLIC_BASE_URL is preferred.
 * WebSocket handshakes are also checked as wss/ws and https/http because
 * Twilio has signed Media Streams with either form.
 */
export function urlCandidates({ publicBaseUrl, host, forwardedProto, path, includeWs = false }) {
  const rawPath = path || '/';
  const set = new Set();
  if (publicBaseUrl) {
    set.add(`${String(publicBaseUrl).replace(/\/$/, '')}${rawPath}`);
  }
  if (host) {
    const proto = String(forwardedProto || '').split(',')[0].trim();
    const schemes = proto ? [proto] : ['https', 'http'];
    for (const scheme of schemes) set.add(`${scheme}://${host}${rawPath}`);
  }
  if (includeWs) {
    for (const url of [...set]) {
      const swapped = swapScheme(url);
      if (swapped) set.add(swapped);
    }
  }
  return [...set];
}
