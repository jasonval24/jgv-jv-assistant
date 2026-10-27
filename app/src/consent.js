/**
 * Phone-action consent gate.
 *
 * Jason's standing rules (voice call 2026-10-26):
 * - Call/SMS is general-purpose, not limited to a fixed recipient list.
 * - Outreach (call or SMS) to anyone other than Jason happens only when Jason
 *   explicitly asks in the current conversation, or when a reminder he set fires.
 * - The agent may call Jason when it is unsure (escalate) without a fresh ask.
 * - No autonomous outreach to third parties.
 */

export const CONSENT_REASONS = {
  ESCALATE_TO_JASON: 'escalate_to_jason',
  SCHEDULED_REMINDER: 'scheduled_reminder',
  JASON_EXPLICIT_REQUEST: 'jason_explicit_request',
  ONLY_JASON_CAN_AUTHORIZE: 'only_jason_can_authorize_outreach',
  NEEDS_EXPLICIT_REQUEST: 'needs_explicit_request_in_this_conversation',
  AUTONOMOUS_THIRD_PARTY: 'autonomous_third_party_blocked',
};

/**
 * @param {object} input
 * @param {'jason'|'scheduler'|'other'|'unknown'} input.actor
 * @param {'call'|'sms'} input.action
 * @param {'jason'|'third_party'} input.targetKind
 * @param {boolean} [input.explicitInCurrentConversation]
 * @param {boolean} [input.reminderAuthorized]
 * @param {'deliver_message'|'conversation'|'escalate'|'reminder'|string} [input.purpose]
 */
export function evaluatePhoneConsent(input = {}) {
  const actor = input.actor || 'unknown';
  const action = input.action;
  const targetKind = input.targetKind;
  const explicit = input.explicitInCurrentConversation === true;
  const reminderAuthorized = input.reminderAuthorized === true;
  const purpose = input.purpose || '';

  if (action === 'call' && targetKind === 'jason' && purpose === 'escalate') {
    return { allowed: true, reason: CONSENT_REASONS.ESCALATE_TO_JASON };
  }

  if (reminderAuthorized && actor === 'scheduler') {
    return { allowed: true, reason: CONSENT_REASONS.SCHEDULED_REMINDER };
  }

  if (targetKind === 'third_party' && actor !== 'jason' && !(reminderAuthorized && actor === 'scheduler')) {
    return { allowed: false, reason: CONSENT_REASONS.AUTONOMOUS_THIRD_PARTY };
  }

  if (actor !== 'jason' && !(reminderAuthorized && actor === 'scheduler')) {
    return { allowed: false, reason: CONSENT_REASONS.ONLY_JASON_CAN_AUTHORIZE };
  }

  if (actor === 'jason' && !explicit && !reminderAuthorized) {
    return { allowed: false, reason: CONSENT_REASONS.NEEDS_EXPLICIT_REQUEST };
  }

  if (actor === 'jason' && explicit) {
    return { allowed: true, reason: CONSENT_REASONS.JASON_EXPLICIT_REQUEST };
  }

  return { allowed: false, reason: CONSENT_REASONS.NEEDS_EXPLICIT_REQUEST };
}

export function resolveActor({ from, jasonCell, normalize }) {
  const norm = normalize || ((p) => String(p || '').replace(/\D/g, '').slice(-10));
  const a = norm(from);
  const b = norm(jasonCell);
  if (!a || !b) return 'unknown';
  return a === b ? 'jason' : 'other';
}

export function targetKindForNumber({ to, jasonCell, normalize }) {
  const norm = normalize || ((p) => String(p || '').replace(/\D/g, '').slice(-10));
  const a = norm(to);
  const b = norm(jasonCell);
  if (a && b && a === b) return 'jason';
  return 'third_party';
}
