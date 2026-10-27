import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_REASONS, evaluatePhoneConsent, resolveActor, targetKindForNumber } from '../src/consent.js';
import { consentForPhoneAction } from '../src/phone/actions.js';

test('Jason explicit request allows a third-party call or SMS', () => {
  for (const action of ['call', 'sms']) {
    const r = evaluatePhoneConsent({
      actor: 'jason',
      action,
      targetKind: 'third_party',
      explicitInCurrentConversation: true,
      purpose: action === 'call' ? 'deliver_message' : 'conversation',
    });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, CONSENT_REASONS.JASON_EXPLICIT_REQUEST);
  }
});

test('Jason without an explicit ask cannot outreach', () => {
  const r = evaluatePhoneConsent({
    actor: 'jason',
    action: 'call',
    targetKind: 'third_party',
    explicitInCurrentConversation: false,
    purpose: 'deliver_message',
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CONSENT_REASONS.NEEDS_EXPLICIT_REQUEST);
});

test('third parties cannot trigger autonomous outreach', () => {
  const r = evaluatePhoneConsent({
    actor: 'other',
    action: 'sms',
    targetKind: 'third_party',
    explicitInCurrentConversation: true,
    purpose: 'conversation',
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, CONSENT_REASONS.AUTONOMOUS_THIRD_PARTY);
});

test('unknown actor cannot place a call', () => {
  const r = evaluatePhoneConsent({
    actor: 'unknown',
    action: 'call',
    targetKind: 'third_party',
    explicitInCurrentConversation: true,
  });
  assert.equal(r.allowed, false);
});

test('scheduler may fire a reminder Jason set', () => {
  const r = evaluatePhoneConsent({
    actor: 'scheduler',
    action: 'sms',
    targetKind: 'third_party',
    reminderAuthorized: true,
    purpose: 'reminder',
  });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, CONSENT_REASONS.SCHEDULED_REMINDER);
});

test('escalate-to-Jason is allowed when the agent is unsure, even if the current caller is not Jason', () => {
  const r = evaluatePhoneConsent({
    actor: 'other',
    action: 'call',
    targetKind: 'jason',
    explicitInCurrentConversation: false,
    purpose: 'escalate',
  });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, CONSENT_REASONS.ESCALATE_TO_JASON);
});

test('resolveActor recognizes Jason from caller ID', () => {
  assert.equal(resolveActor({ from: '+19564601983', jasonCell: '+1 (956) 460-1983' }), 'jason');
  assert.equal(resolveActor({ from: '+15551212', jasonCell: '+19564601983' }), 'other');
  assert.equal(resolveActor({ from: '', jasonCell: '+19564601983' }), 'unknown');
});

test('consentForPhoneAction blocks protected numbers and requires an explicit Jason ask', () => {
  const blocked = consentForPhoneAction({
    actor: 'jason',
    action: 'call',
    to: '+13613360871',
    jasonCell: '+19564601983',
    explicitInCurrentConversation: true,
    purpose: 'deliver_message',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'protected_number');

  const denied = consentForPhoneAction({
    actor: 'jason',
    action: 'sms',
    to: '+15555550100',
    jasonCell: '+19564601983',
    explicitInCurrentConversation: false,
    purpose: 'conversation',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, CONSENT_REASONS.NEEDS_EXPLICIT_REQUEST);

  const ok = consentForPhoneAction({
    actor: 'jason',
    action: 'call',
    to: '555-555-0100',
    jasonCell: '+19564601983',
    explicitInCurrentConversation: true,
    purpose: 'deliver_message',
  });
  assert.equal(ok.allowed, true);
  assert.equal(targetKindForNumber({ to: '+19564601983', jasonCell: '+19564601983' }), 'jason');
});
