import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  REMINDER_DEFAULTS,
  buildReminder,
  cancelReminder,
  dueReminders,
  fireDueReminders,
  reminderIsDue,
  scheduleReminder,
} from '../src/reminders.js';

const TZ = 'America/Chicago';

test('buildReminder rejects past times and empty content', () => {
  const now = new Date('2026-10-27T15:00:00.000Z');
  const past = buildReminder({
    channel: 'sms_jason',
    to: '+19564601983',
    content: 'hello',
    whenIso: '2026-10-27T14:00:00.000Z',
    now,
    timeZone: TZ,
  });
  assert.equal(past.ok, false);
  assert.equal(past.error, 'when_in_past');

  const empty = buildReminder({
    channel: 'call_jason',
    content: '  ',
    whenIso: '2026-10-27T16:00:00.000Z',
    now,
    timeZone: TZ,
  });
  assert.equal(empty.ok, false);
});

test('scheduleReminder persists and survives a store reload', () => {
  const now = new Date('2026-10-27T15:00:00.000Z');
  const store = createMemoryStore(REMINDER_DEFAULTS);
  const created = scheduleReminder(store, {
    channel: 'sms_other',
    to: '+15555550100',
    content: 'Running late',
    whenIso: '2026-10-27T16:30:00.000Z',
    now,
    timeZone: TZ,
  });
  assert.equal(created.ok, true);
  assert.equal(created.reminder.status, 'pending');

  const reloaded = createMemoryStore(store.read());
  const rows = reloaded.read().reminders;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Running late');
  assert.equal(rows[0].id, created.reminder.id);
});

test('dueReminders respects the clock — future is not due, then is due after advance', async () => {
  const t0 = new Date('2026-10-27T15:00:00.000Z');
  const fireAt = new Date('2026-10-27T15:10:00.000Z');
  const store = createMemoryStore(REMINDER_DEFAULTS);
  const created = scheduleReminder(store, {
    channel: 'call_jason',
    to: '+19564601983',
    content: 'Call me about the invoice',
    whenIso: fireAt.toISOString(),
    now: t0,
    timeZone: TZ,
  });
  assert.equal(reminderIsDue(created.reminder, t0.getTime()), false);
  assert.equal(dueReminders(store.read().reminders, t0.getTime()).length, 0);
  assert.equal(dueReminders(store.read().reminders, fireAt.getTime()).length, 1);

  const calls = [];
  const sms = [];
  const early = await fireDueReminders({
    store,
    now: t0,
    sendSms: async (a) => { sms.push(a); return { ok: true }; },
    placeCall: async (a) => { calls.push(a); return { ok: true, callSid: 'CAtest' }; },
  });
  assert.equal(early.fired, 0);
  assert.equal(calls.length, 0);

  const later = await fireDueReminders({
    store,
    now: fireAt,
    sendSms: async (a) => { sms.push(a); return { ok: true }; },
    placeCall: async (a) => { calls.push(a); return { ok: true, callSid: 'CAtest' }; },
  });
  assert.equal(later.fired, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reminderAuthorized, true);
  assert.equal(calls[0].actor, 'scheduler');
  assert.equal(calls[0].message, 'Call me about the invoice');
  assert.equal(store.read().reminders[0].status, 'fired');
});

test('SMS reminder to another number fires with the specified content', async () => {
  const now = new Date('2026-10-27T18:00:00.000Z');
  const store = createMemoryStore(REMINDER_DEFAULTS);
  scheduleReminder(store, {
    channel: 'sms_other',
    to: '+15555550199',
    content: 'Pick up Ollie at 4',
    whenIso: now.toISOString(),
    now: new Date(now.getTime() - 60_000),
    timeZone: TZ,
  });
  const sent = [];
  await fireDueReminders({
    store,
    now,
    sendSms: async (a) => { sent.push(a); return { ok: true, sid: 'SMtest' }; },
    placeCall: async () => ({ ok: false }),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+15555550199');
  assert.equal(sent[0].body, 'Pick up Ollie at 4');
});

test('cancelReminder marks a pending reminder cancelled', () => {
  const store = createMemoryStore(REMINDER_DEFAULTS);
  const created = scheduleReminder(store, {
    channel: 'sms_jason',
    to: '+19564601983',
    content: 'Stand up',
    whenIso: '2026-10-28T15:00:00.000Z',
    now: new Date('2026-10-27T15:00:00.000Z'),
    timeZone: TZ,
  });
  const cancelled = cancelReminder(store, created.reminder.id);
  assert.equal(cancelled.ok, true);
  assert.equal(store.read().reminders[0].status, 'cancelled');
  assert.equal(dueReminders(store.read().reminders, Date.parse('2026-10-28T16:00:00.000Z')).length, 0);
});
