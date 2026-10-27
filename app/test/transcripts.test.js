import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTranscriptRecords } from '../src/twilio/transcripts.js';

const now = new Date('2026-10-27T18:00:00.000Z');

const records = [
  {
    callSid: 'CAaaa0000000000000000000000000001',
    dateCreated: '2026-10-20T15:00:00.000Z',
    text: 'Jason: go with the oak cabinets. Anna: agreed, oak for the kitchen.',
    recordingSid: 'REaaa',
    source: 'voice_intelligence',
  },
  {
    callSid: 'CAaaa0000000000000000000000000002',
    dateCreated: '2026-08-01T15:00:00.000Z',
    text: 'Jason: we should stain the fence next spring.',
    recordingSid: 'REbbb',
    source: 'recording_transcription',
  },
  {
    callSid: 'CAaaa0000000000000000000000000003',
    dateCreated: '2026-10-25T12:00:00.000Z',
    text: 'Left a voicemail about picking up Ollie from school.',
    source: 'openai_whisper',
  },
];

test('transcript search finds matching recent calls and returns a snippet plus CallSid', () => {
  const result = searchTranscriptRecords(records, { query: 'oak cabinets kitchen', now, sinceDays: 60 });
  assert.equal(result.ok, true);
  assert.ok(result.matchCount >= 1);
  assert.equal(result.matches[0].callSid, 'CAaaa0000000000000000000000000001');
  assert.match(result.matches[0].snippet.toLowerCase(), /oak/);
  assert.equal(result.matches[0].source, 'voice_intelligence');
});

test('transcript search window excludes calls older than the look-back', () => {
  const inWindow = searchTranscriptRecords(records, { query: 'fence', now, sinceDays: 60 });
  assert.equal(inWindow.matchCount, 0);
  const wide = searchTranscriptRecords(records, { query: 'fence', now, sinceDays: 120 });
  assert.equal(wide.matchCount, 1);
  assert.equal(wide.matches[0].callSid, 'CAaaa0000000000000000000000000002');
});

test('transcript search returns no matches for unrelated queries', () => {
  const result = searchTranscriptRecords(records, { query: 'tax audit quarterly filing', now, sinceDays: 60 });
  assert.equal(result.matchCount, 0);
  assert.deepEqual(result.matches, []);
});

test('empty query lists recent transcripts inside the window only', () => {
  const result = searchTranscriptRecords(records, { query: '', now, sinceDays: 60, limit: 10 });
  const sids = result.matches.map((m) => m.callSid);
  assert.ok(sids.includes('CAaaa0000000000000000000000000001'));
  assert.ok(sids.includes('CAaaa0000000000000000000000000003'));
  assert.ok(!sids.includes('CAaaa0000000000000000000000000002'));
});
