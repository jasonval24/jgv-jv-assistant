import crypto from 'crypto';
import { parseWhen } from './time.js';

export const REMINDER_DEFAULTS = { version: 1, reminders: [] };

export function reminderIsDue(reminder, nowMs) {
  return reminder?.status === 'pending' && Number(reminder.fireAtMs) <= nowMs;
}

export function dueReminders(reminders, nowMs) {
  return (reminders || []).filter((r) => reminderIsDue(r, nowMs));
}

export function buildReminder({
  channel,
  to,
  toJason = false,
  content,
  whenIso,
  whenPhrase,
  now = new Date(),
  timeZone = 'America/Chicago',
  conversationId = null,
} = {}) {
  if (!['call_jason', 'sms_jason', 'sms_other'].includes(channel)) {
    return { ok: false, error: 'invalid_channel' };
  }
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: 'missing_content' };
  const when = parseWhen({ whenIso, whenPhrase, now, timeZone });
  if (!when.ok) return { ok: false, error: when.error || 'invalid_when' };
  if (when.at.getTime() <= now.getTime() - 2000) {
    return { ok: false, error: 'when_in_past' };
  }
  return {
    ok: true,
    reminder: {
      id: `rem_${crypto.randomBytes(8).toString('hex')}`,
      status: 'pending',
      channel,
      to: to || null,
      toJason: Boolean(toJason),
      content: text.slice(0, 4000),
      fireAt: when.at.toISOString(),
      fireAtMs: when.at.getTime(),
      timeZone,
      createdAt: now.toISOString(),
      conversationId,
      lastError: null,
    },
  };
}

export function scheduleReminder(store, spec) {
  const built = buildReminder(spec);
  if (!built.ok) return built;
  store.update((data) => {
    const next = data && Array.isArray(data.reminders) ? data : { ...REMINDER_DEFAULTS };
    next.reminders.push(built.reminder);
    next.version = 1;
    return next;
  });
  return { ok: true, reminder: built.reminder };
}

export function cancelReminder(store, id) {
  let found = null;
  store.update((data) => {
    const next = data && Array.isArray(data.reminders) ? data : { ...REMINDER_DEFAULTS };
    next.reminders = next.reminders.map((r) => {
      if (r.id !== id) return r;
      found = { ...r, status: 'cancelled', cancelledAt: new Date().toISOString() };
      return found;
    });
    return next;
  });
  if (!found) return { ok: false, error: 'not_found' };
  return { ok: true, reminder: found };
}

export function listReminders(store, { includeFinished = false } = {}) {
  const data = store.read();
  const rows = Array.isArray(data?.reminders) ? data.reminders : [];
  return includeFinished ? rows : rows.filter((r) => r.status === 'pending');
}

export async function fireDueReminders({
  store,
  now = new Date(),
  sendSms,
  placeCall,
} = {}) {
  const nowMs = now.getTime();
  const data = store.read();
  const due = dueReminders(data?.reminders || [], nowMs);
  const results = [];
  for (const rem of due) {
    store.update((cur) => {
      const next = cur && Array.isArray(cur.reminders) ? cur : { ...REMINDER_DEFAULTS };
      next.reminders = next.reminders.map((r) =>
        r.id === rem.id ? { ...r, status: 'firing' } : r
      );
      return next;
    });
    let outcome;
    try {
      if (rem.channel === 'sms_jason' || rem.channel === 'sms_other') {
        outcome = await sendSms({
          to: rem.to,
          body: rem.content,
          actor: 'scheduler',
          reminderAuthorized: true,
          reminderId: rem.id,
        });
      } else if (rem.channel === 'call_jason') {
        outcome = await placeCall({
          to: rem.to,
          message: rem.content,
          purpose: 'reminder',
          actor: 'scheduler',
          reminderAuthorized: true,
          reminderId: rem.id,
        });
      } else {
        outcome = { ok: false, error: 'unsupported_channel' };
      }
    } catch (err) {
      outcome = { ok: false, error: 'fire_failed', message: err?.message || 'fire_failed' };
    }
    const status = outcome?.ok ? 'fired' : 'failed';
    store.update((cur) => {
      const next = cur && Array.isArray(cur.reminders) ? cur : { ...REMINDER_DEFAULTS };
      next.reminders = next.reminders.map((r) =>
        r.id === rem.id
          ? {
              ...r,
              status,
              firedAt: new Date().toISOString(),
              lastError: outcome?.ok ? null : outcome?.error || 'failed',
              result: outcome && typeof outcome === 'object' ? { ok: outcome.ok, error: outcome.error || null } : null,
            }
          : r
      );
      return next;
    });
    results.push({ id: rem.id, status, outcome });
  }
  return { ok: true, fired: results.length, results };
}

export function startReminderScheduler({
  store,
  intervalMs = 20_000,
  sendSms,
  placeCall,
  nowFn = () => new Date(),
} = {}) {
  const tick = () =>
    fireDueReminders({
      store,
      now: nowFn(),
      sendSms,
      placeCall,
    }).catch(() => ({ ok: false }));
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    tick,
    stop() {
      clearInterval(timer);
    },
  };
}
