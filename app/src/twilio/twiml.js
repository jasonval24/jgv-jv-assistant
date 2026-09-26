import { config } from '../config.js';

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function mediaStreamUrl(publicBase) {
  const base = String(publicBase || '').replace(/\/$/, '');
  const url = new URL(`${base}/twilio/media`);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** TwiML that connects the live call to the Media Streams WebSocket. */
export function buildStreamTwiml({ streamUrl, callSid, from, to }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEscape(streamUrl)}"><Parameter name="callSid" value="${xmlEscape(callSid)}"/><Parameter name="from" value="${xmlEscape(from || '')}"/><Parameter name="to" value="${xmlEscape(to || '')}"/></Stream></Connect></Response>`;
}

export function rejectTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';
}

export function sayHangupTwiml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(message)}</Say><Hangup/></Response>`;
}

export function emptyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
}

/**
 * Redirect the live CallSid to Jason. actionUrl receives DialCallStatus
 * so a failed dial can speak a fallback instead of dead air.
 */
export function buildDialTwiml({ to, callerId, actionUrl }) {
  const action = actionUrl
    ? ` action="${xmlEscape(actionUrl)}" method="POST"`
    : '';
  const caller = callerId ? ` callerId="${xmlEscape(callerId)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial${caller} timeout="25"${action}><Number>${xmlEscape(to)}</Number></Dial></Response>`;
}

export function dialActionUrl() {
  if (!config.publicBaseUrl) return null;
  return `${config.publicBaseUrl}/twilio/dial-result`;
}
