import crypto from 'crypto';

export const JOB_DEFAULTS = { version: 1, jobs: {} };

const TTL_MS = 6 * 60 * 60 * 1000;

export function createJobToken() {
  return crypto.randomBytes(12).toString('hex');
}

export function putJob(store, job) {
  const token = job.token || createJobToken();
  const rec = {
    ...job,
    token,
    createdAt: job.createdAt || new Date().toISOString(),
    expMs: job.expMs || Date.now() + TTL_MS,
  };
  store.update((data) => {
    const next = data && data.jobs ? data : { ...JOB_DEFAULTS };
    next.jobs[token] = rec;
    const now = Date.now();
    for (const [k, v] of Object.entries(next.jobs)) {
      if (v?.expMs && v.expMs < now) delete next.jobs[k];
    }
    next.version = 1;
    return next;
  });
  return rec;
}

export function getJob(store, token) {
  if (!token) return null;
  const data = store.read();
  const rec = data?.jobs?.[token];
  if (!rec) return null;
  if (rec.expMs && rec.expMs < Date.now()) return null;
  return rec;
}

export function getJobByCallSid(store, callSid) {
  if (!callSid) return null;
  const data = store.read();
  const jobs = data?.jobs || {};
  return Object.values(jobs).find((j) => j.callSid === callSid) || null;
}

export function patchJob(store, token, fields) {
  let updated = null;
  store.update((data) => {
    const next = data && data.jobs ? data : { ...JOB_DEFAULTS };
    if (!next.jobs[token]) return next;
    next.jobs[token] = { ...next.jobs[token], ...fields, updatedAt: new Date().toISOString() };
    updated = next.jobs[token];
    return next;
  });
  return updated;
}

export function classifyCallOutcome({ callStatus, answeredBy } = {}) {
  const amd = String(answeredBy || '').toLowerCase();
  const status = String(callStatus || '').toLowerCase();
  if (amd.startsWith('machine') || amd === 'fax') return 'voicemail';
  if (status === 'no-answer' || status === 'busy' || status === 'failed' || status === 'canceled') {
    return status === 'busy' ? 'busy' : status === 'failed' || status === 'canceled' ? status : 'no_answer';
  }
  if (amd === 'human' || status === 'in-progress' || status === 'completed' || status === 'answered') {
    return 'answered';
  }
  if (status === 'ringing' || status === 'queued') return 'pending';
  return status || 'unknown';
}
