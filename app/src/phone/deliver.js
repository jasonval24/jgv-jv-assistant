import { xmlEscape } from '../twilio/twiml.js';
import { classifyCallOutcome, patchJob } from './jobs.js';
import { remember as persistMemory } from '../memory.js';
import { notifyJason } from '../telegram.js';
import { config } from '../config.js';
import { memoryStore } from '../stores.js';

export function deliverMessageTwiml({ message, gatherActionUrl }) {
  const spoken = String(message || '').trim().slice(0, 3000) || 'Jason asked me to call. He did not leave a specific message.';
  const gather = gatherActionUrl
    ? `<Gather input="speech" timeout="8" speechTimeout="auto" action="${xmlEscape(gatherActionUrl)}" method="POST"><Say>If you would like to leave a reply for Jason, please speak after this.</Say></Gather>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say>${xmlEscape(spoken)}</Say>${gather}<Hangup/></Response>`;
}

export function deliverReplyTwiml() {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Thanks. I will pass that along to Jason. Goodbye.</Say><Hangup/></Response>';
}

export function buildDeliverReport(job = {}) {
  const outcome = classifyCallOutcome({
    callStatus: job.callStatus,
    answeredBy: job.answeredBy,
  });
  const reply = String(job.reply || '').trim();
  return {
    ok: true,
    purpose: job.purpose || 'deliver_message',
    to: job.to || null,
    callSid: job.callSid || null,
    outcome,
    answeredBy: job.answeredBy || null,
    callStatus: job.callStatus || null,
    reply: reply || null,
    message: job.message || null,
  };
}

export function spokenOutcome(report) {
  if (!report) return 'The call finished, but I do not have a status yet.';
  if (report.outcome === 'answered') {
    return report.reply
      ? `They answered. Their reply: ${report.reply}`
      : 'They answered. I delivered the message. No spoken reply was captured.';
  }
  if (report.outcome === 'voicemail') {
    return 'It went to voicemail. I left the message you dictated.';
  }
  if (report.outcome === 'no_answer') return 'No answer.';
  if (report.outcome === 'busy') return 'The line was busy.';
  if (report.outcome === 'failed' || report.outcome === 'canceled') {
    return `The call did not go through (${report.outcome}).`;
  }
  return `Call status: ${report.outcome}.`;
}

export async function finalizeDeliverJob(store, job, { notify = notifyJason } = {}) {
  if (!job || job.reported) return job;
  const report = buildDeliverReport(job);
  const spoken = spokenOutcome(report);
  const updated = patchJob(store, job.token, { reported: true, outcome: report.outcome });
  try {
    persistMemory(
      memoryStore,
      {
        channel: 'deliver_call',
        conversationId: job.token,
        callSid: job.callSid || null,
        title: `Deliver-message call (${report.outcome})`,
        summary: spoken,
        key_statements: [
          job.message ? { speaker: 'jason_message', text: job.message } : null,
          report.reply ? { speaker: 'recipient', text: report.reply } : null,
        ].filter(Boolean),
      },
      { now: new Date(), timeZone: config.timezone, retentionDays: config.memoryRetentionDays }
    );
  } catch {
    /* ignore */
  }
  const dest = job.to ? String(job.to).replace(/.(?=.{4})/g, '*') : 'unknown';
  await notify(
    `📞 JV Assistant deliver-call result\nTo: ${dest}\nOutcome: ${report.outcome}\n${spoken}`
  );
  return updated;
}
