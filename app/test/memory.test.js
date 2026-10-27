import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import {
  MEMORY_DEFAULTS,
  filterEntriesByWindow,
  recallMemory,
  remember,
} from '../src/memory.js';

test('recall window includes last 60 days by default and drops older entries', () => {
  const now = new Date('2026-10-27T18:00:00.000Z');
  const store = createMemoryStore(MEMORY_DEFAULTS);
  remember(
    store,
    {
      title: 'Kitchen remodel',
      summary: 'We decided to use oak cabinets.',
      decisions: ['Use oak cabinets for the kitchen'],
      conversationId: 'jv_recent',
      callSid: 'CArecent00000000000000000000000000',
    },
    { now: new Date(now.getTime() - 10 * 86_400_000), timeZone: 'America/Chicago', retentionDays: 365 }
  );
  remember(
    store,
    {
      title: 'Old fence',
      summary: 'We decided to stain the fence.',
      decisions: ['Stain the fence next spring'],
      conversationId: 'jv_old',
    },
    { now: new Date(now.getTime() - 90 * 86_400_000), timeZone: 'America/Chicago', retentionDays: 365 }
  );

  const sixty = recallMemory(store.read().entries, { query: 'decided kitchen cabinets', now, retentionDays: 60 });
  assert.equal(sixty.matchCount, 1);
  assert.equal(sixty.matches[0].conversationId, 'jv_recent');
  assert.equal(sixty.matches[0].decisions[0].text.includes('oak'), true);
  assert.equal(sixty.matches[0].callSid.startsWith('CA'), true);

  const oldHit = recallMemory(store.read().entries, { query: 'fence', now, retentionDays: 60 });
  assert.equal(oldHit.matchCount, 0);

  const wide = recallMemory(store.read().entries, { query: 'fence', now, retentionDays: 120 });
  assert.equal(wide.matchCount, 1);
  assert.equal(wide.matches[0].conversationId, 'jv_old');
});

test('custom 30-day window excludes a 45-day-old decision', () => {
  const now = new Date('2026-10-27T18:00:00.000Z');
  const store = createMemoryStore(MEMORY_DEFAULTS);
  remember(
    store,
    {
      summary: 'Hire the painter',
      decisions: ['Hire the painter for the hall'],
      conversationId: 'jv_mid',
    },
    { now: new Date(now.getTime() - 45 * 86_400_000), timeZone: 'America/Chicago', retentionDays: 365 }
  );
  const thirty = recallMemory(store.read().entries, { query: 'painter', now, retentionDays: 30 });
  assert.equal(thirty.matchCount, 0);
  const sixty = recallMemory(store.read().entries, { query: 'painter', now, retentionDays: 60 });
  assert.equal(sixty.matchCount, 1);
});

test('filterEntriesByWindow is date-based, not query-based', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const rows = [
    { createdAt: '2026-05-20T00:00:00.000Z', summary: 'in' },
    { createdAt: '2026-03-01T00:00:00.000Z', summary: 'out' },
  ];
  const kept = filterEntriesByWindow(rows, { now, retentionDays: 60 });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].summary, 'in');
});

test('query matches key statements and returns the date', () => {
  const now = new Date('2026-10-27T18:00:00.000Z');
  const store = createMemoryStore(MEMORY_DEFAULTS);
  remember(
    store,
    {
      summary: 'Talked about Ollie school pickup',
      key_statements: [{ speaker: 'Jason', text: 'Anna will pick up Ollie on Thursdays' }],
      decisions: ['Anna handles Thursday pickup'],
      conversationId: 'jv_school',
    },
    { now: new Date(now.getTime() - 5 * 86_400_000), timeZone: 'America/Chicago' }
  );
  const result = recallMemory(store.read().entries, { query: 'last month Ollie pickup', now, retentionDays: 60 });
  assert.ok(result.matchCount >= 1);
  assert.equal(result.matches[0].date, '2026-10-22');
  assert.match(result.matches[0].keyStatements[0].text, /Thursday/);
});
