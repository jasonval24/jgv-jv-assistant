import express from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { WebSocketServer } from 'ws';
import { config, redact } from './config.js';
import { createClientSecret, buildSessionConfig } from './session.js';
import { runTool } from './tools/handlers.js';
import { twilioSignatureIsValid, urlCandidates } from './twilio/signature.js';
import {
  buildStreamTwiml,
  dialActionUrl,
  emptyTwiml,
  mediaStreamUrl,
  rejectTwiml,
  sayHangupTwiml,
  xmlEscape,
} from './twilio/twiml.js';
import {
  JV_TWILIO_DID_E164,
  PROTECTED_LEADCONNECTOR_E164,
  TRANSFER_TARGET_E164,
  callSessionIdForCallSid,
  isProtectedLeadConnector,
  maskPhone,
} from './twilio/numbers.js';
import { createMediaBridge } from './twilio/media-bridge.js';
import { logEvent } from './twilio/log.js';
import { handleInboundSms } from './sms/handler.js';
import crypto from 'crypto';
import { getOutbound, placeOutboundCall, previewOutbound, registerRealtimeJob } from './outbound.js';
import { jobStore, reminderStore } from './stores.js';
import { getJob, patchJob } from './phone/jobs.js';
import { applyCallStatusToJob, placeOutboundPhoneCall, sendSms } from './phone/actions.js';
import { deliverMessageTwiml, deliverReplyTwiml, finalizeDeliverJob } from './phone/deliver.js';
import { startReminderScheduler } from './reminders.js';
import { jasonCellE164 } from './twilio/numbers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../public');

function requestUrlCandidates(req, { includeWs = false } = {}) {
  const hostHeader = req.headers?.['x-forwarded-host'] || req.headers?.host || req.get?.('host') || '';
  const protoHeader = req.headers?.['x-forwarded-proto'] || req.protocol || '';
  return urlCandidates({
    publicBaseUrl: config.publicBaseUrl,
    host: String(hostHeader).split(',')[0].trim(),
    forwardedProto: protoHeader,
    path: req.originalUrl || req.url || '/',
    includeWs,
  });
}

function publicBaseFromRequest(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const hostHeader = req.headers?.['x-forwarded-host'] || req.get?.('host') || req.headers?.host || '';
  const proto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(hostHeader).split(',')[0].trim();
  return `${proto}://${host}`;
}

function signatureOk(req, { includeWs = false } = {}) {
  if (!config.twilioAuthToken) return false;
  const signature = req.headers?.['x-twilio-signature'] || req.get?.('x-twilio-signature') || '';
  const params = includeWs ? {} : (req.body && typeof req.body === 'object' ? req.body : {});
  return twilioSignatureIsValid({
    authToken: config.twilioAuthToken,
    signature,
    urls: requestUrlCandidates(req, { includeWs }),
    params,
  });
}

export function createServer(options = {}) {
  const logger = options.logger || logEvent;
  const bridges = new Set();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: config.serviceName,
      assistant: 'JV Assistant',
      owner: 'Jason Valenzuela',
      model: config.openaiModel,
      chatModel: config.openaiChatModel,
      voice: config.openaiVoice,
      https: false,
      promptLoaded: true,
      openaiConfigured: Boolean(config.openaiApiKey),
      twilioConfigured: Boolean(config.twilioAccountSid && config.twilioAuthToken),
      telegramConfigured: Boolean(config.telegramBotToken),
      publicBaseUrl: config.publicBaseUrl || null,
      voiceDid: JV_TWILIO_DID_E164,
      transferTarget: config.transferToJason || config.jasonCell || TRANSFER_TARGET_E164,
      protectedLeadConnector: PROTECTED_LEADCONNECTOR_E164,
      activeBridges: bridges.size,
      endpoints: {
        health: '/health',
        voice: '/twilio/voice',
        sms: '/twilio/sms',
        status: '/twilio/status',
        media: '/twilio/media',
        dialResult: '/twilio/dial-result',
        deliver: '/twilio/deliver',
        recording: '/twilio/recording',
      },
      memoryRetentionDays: config.memoryRetentionDays,
      dataDirConfigured: Boolean(process.env.DATA_DIR),
      voiceIntelligenceConfigured: Boolean(config.twilioVoiceIntelligenceSid),
      jasonCellConfigured: Boolean(config.jasonCell),
    });
  });

  app.get('/api/session-preview', (_req, res) => {
    try {
      const session = buildSessionConfig();
      res.json({
        model: session.model,
        voice: session.audio?.output?.voice,
        instructionsChars: session.instructions?.length || 0,
        instructionsPreview: (session.instructions || '').slice(0, 180) + '…',
        tools: (session.tools || []).map((t) => t.name),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/token', async (_req, res) => {
    try {
      if (!config.openaiApiKey) {
        return res.status(503).json({ error: 'OPENAI_API_KEY is not configured' });
      }
      const data = await createClientSecret();
      const value = data.value || data.client_secret?.value;
      const expires_at = data.expires_at || data.client_secret?.expires_at;
      if (!value) {
        return res.status(502).json({ error: 'Unexpected OpenAI client_secrets response' });
      }
      res.json({ value, expires_at, model: config.openaiModel });
    } catch (err) {
      console.error('[token] failed', err.status || '', err.message, redact(err.details || {}));
      res.status(err.status || 500).json({
        error: 'Failed to create Realtime client secret',
        status: err.status || 500,
      });
    }
  });

  app.post('/tools/:name', async (req, res) => {
    const name = req.params.name;
    try {
      const result = await runTool(name, req.body || {});
      res.json(result);
    } catch (err) {
      console.error(`[tools/${name}]`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  function requireTwilioSignature(req, res) {
    if (!config.twilioAuthToken) {
      logger('twilio_auth_not_configured', { path: req.path });
      res.status(503).type('text/plain').send('twilio signature validation is not configured');
      return false;
    }
    if (!signatureOk(req)) {
      logger('twilio_signature_rejected', { path: req.path });
      res.status(403).type('text/plain').send('forbidden');
      return false;
    }
    return true;
  }

  app.post('/twilio/voice', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = req.body?.CallSid || '';
    const from = req.body?.From || '';
    const to = req.body?.To || '';
    const callSessionId = callSessionIdForCallSid(callSid);
    if (isProtectedLeadConnector(to)) {
      logger('voice_rejected_protected_number', { callSid });
      res.type('text/xml').status(200).send(rejectTwiml());
      return;
    }
    if (!callSessionId) {
      logger('voice_rejected_invalid_call', { callSid });
      res.status(400).type('text/plain').send('invalid CallSid');
      return;
    }
    if (!config.openaiApiKey) {
      logger('voice_rejected_openai_unconfigured', { callSessionId });
      res.type('text/xml').status(200).send(
        sayHangupTwiml('We cannot take this call right now. Please try again in a few minutes.')
      );
      return;
    }
    const streamUrl = mediaStreamUrl(publicBaseFromRequest(req));
    logger('voice_webhook', {
      callSid,
      callSessionId,
      from,
      to: maskPhone(to) ? to : null,
    });
    const ob = getOutbound(String(req.query?.ob || '')) ? String(req.query.ob) : undefined;
    if (req.query?.ob && !ob) {
      res.type('text/xml').status(200).send(sayHangupTwiml('Sorry, this call has expired. Goodbye.'));
      return;
    }
    res.type('text/xml').status(200).send(buildStreamTwiml({ streamUrl, callSid, from, to, ob }));
  });

  app.post('/twilio/sms', async (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const from = req.body?.From || '';
    const to = req.body?.To || '';
    const body = req.body?.Body || '';
    const messageSid = req.body?.MessageSid || req.body?.SmsSid || '';
    try {
      const result = await handleInboundSms({ from, to, body, messageSid });
      const reply = result?.reply ? String(result.reply) : '';
      logger('sms_webhook', {
        messageSid,
        from,
        replied: Boolean(reply),
        telegramNotified: Boolean(result?.telegramNotified),
      });
      if (reply) {
        res
          .type('text/xml')
          .status(200)
          .send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`
          );
      } else {
        res.type('text/xml').status(200).send(emptyTwiml());
      }
    } catch (err) {
      logger('sms_webhook_error', { message: err?.message || 'sms_failed' });
      res
        .type('text/xml')
        .status(200)
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(
            "Thanks — I've notified Jason."
          )}</Message></Response>`
        );
    }
  });

  app.post('/api/outbound-call', async (req, res) => {
    const secret = process.env.OUTBOUND_CALL_SECRET || '';
    const got = String(req.get('x-call-secret') || '');
    if (!secret || got.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
      res.status(401).json({ ok: false });
      return;
    }
    const who = String(req.body?.to || '').toLowerCase();
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    const thread = Array.isArray(req.body?.thread) ? req.body.thread.slice(-20) : [];
    const interview = String(req.body?.interview || '').trim().slice(0, 2000);
    if (!message) { res.status(400).json({ ok: false, error: 'message_required' }); return; }
    if (req.body?.dry_run) { res.json(previewOutbound({ who, message, thread, interview })); return; }
    try {
      const r = await placeOutboundCall({ who, message, thread, interview, publicBase: config.publicBaseUrl || publicBaseFromRequest(req) });
      logger('outbound_call_request', { who, ok: Boolean(r.body?.ok), callSid: r.body?.callSid || null, reason: r.body?.reason || r.body?.error || null });
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || 'outbound_failed' });
    }
  });

  app.post('/twilio/deliver', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const tok = String(req.query?.tok || '');
    const job = getJob(jobStore, tok);
    if (!job) {
      res.type('text/xml').status(200).send(sayHangupTwiml('Sorry, this call has expired. Goodbye.'));
      return;
    }
    if (req.body?.CallSid) patchJob(jobStore, tok, { callSid: req.body.CallSid });
    const gatherUrl = `${publicBaseFromRequest(req)}/twilio/deliver-reply?tok=${encodeURIComponent(tok)}`;
    logger('deliver_twiml', { callSid: req.body?.CallSid || null, token: tok });
    res.type('text/xml').status(200).send(deliverMessageTwiml({ message: job.message, gatherActionUrl: gatherUrl }));
  });

  app.post('/twilio/deliver-reply', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const tok = String(req.query?.tok || '');
    const speech = String(req.body?.SpeechResult || req.body?.TranscriptionText || '').trim();
    if (tok && speech) patchJob(jobStore, tok, { reply: speech });
    logger('deliver_reply', { token: tok, hasReply: Boolean(speech) });
    res.type('text/xml').status(200).send(deliverReplyTwiml());
  });

  app.post('/twilio/recording', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = req.body?.CallSid || '';
    const recordingSid = req.body?.RecordingSid || '';
    const job = applyCallStatusToJob(jobStore, { callSid });
    if (job && recordingSid) patchJob(jobStore, job.token, { recordingSid });
    logger('recording_ready', { callSid, recordingSid: recordingSid ? `RE…${String(recordingSid).slice(-4)}` : null });
    res.type('text/xml').status(200).send(emptyTwiml());
  });

  app.post('/twilio/status', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    if (req.body?.AnsweredBy) logger('amd_result', { callSid: req.body?.CallSid || null, answeredBy: req.body.AnsweredBy });
    const callSid = req.body?.CallSid || '';
    const callStatus = String(req.body?.CallStatus || '').toLowerCase();
    const answeredBy = req.body?.AnsweredBy || '';
    const callSessionId = callSessionIdForCallSid(callSid);
    const job = applyCallStatusToJob(jobStore, { callSid, callStatus, answeredBy });
    logger('call_status', { callSid, callStatus, callSessionId, purpose: job?.purpose || null });
    const terminal = ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(callStatus);
    if (terminal && job && job.kind === 'deliver' && !job.reported) {
      void finalizeDeliverJob(jobStore, { ...job, callStatus, answeredBy: answeredBy || job.answeredBy });
    }
    res.type('text/xml').status(200).send(emptyTwiml());
  });

  app.post('/twilio/dial-result', (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const dialStatus = String(req.body?.DialCallStatus || '').toLowerCase();
    logger('dial_result', { callSid: req.body?.CallSid || null, dialStatus });
    if (dialStatus && dialStatus !== 'completed' && dialStatus !== 'answered') {
      res.type('text/xml').status(200).send(
        sayHangupTwiml(
          'Sorry, Jason is not available right now. Please leave a message by texting this number, or try again later.'
        )
      );
      return;
    }
    res.type('text/xml').status(200).send(emptyTwiml());
  });

  const certsDir = path.join(__dirname, '../certs');
  const keyPath = path.join(certsDir, 'localhost-key.pem');
  const certPath = path.join(certsDir, 'localhost-cert.pem');
  const useHttps = fs.existsSync(keyPath) && fs.existsSync(certPath);
  const server = useHttps
    ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    : http.createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== '/twilio/media') {
      socket.destroy();
      return;
    }
    if (!config.twilioAuthToken || !signatureOk(req, { includeWs: true })) {
      logger('twilio_signature_rejected', { path: '/twilio/media' });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 9\r\n\r\nforbidden');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const bridge = createMediaBridge(ws, options);
      bridges.add(bridge);
      ws.on('close', () => bridges.delete(bridge));
    });
  });

  const scheduler = options.startScheduler === false
    ? null
    : startReminderScheduler({
        store: reminderStore,
        intervalMs: Math.max(5, Number(config.reminderPollSeconds) || 20) * 1000,
        sendSms: (args) =>
          sendSms({
            ...args,
            jasonCell: config.jasonCell,
          }),
        placeCall: (args) =>
          placeOutboundPhoneCall({
            store: jobStore,
            to: args.to || jasonCellE164(),
            message: args.message,
            purpose: 'reminder',
            actor: args.actor || 'scheduler',
            reminderAuthorized: true,
            reminderId: args.reminderId,
            publicBase: config.publicBaseUrl,
            registerRealtime: (rec) =>
              registerRealtimeJob({ ...rec, purpose: 'reminder', who: 'jason', name: 'Jason Valenzuela' }),
          }),
      });

  return { app, server, wss, bridges, useHttps, scheduler, dialActionUrl: dialActionUrl() };
}

export async function shutdown(server, bridges, scheduler) {
  logEvent('shutdown_start', { activeBridges: bridges?.size || 0 });
  try { scheduler?.stop?.(); } catch { /* ignore */ }
  if (bridges) {
    for (const bridge of [...bridges]) {
      try { bridge.close(); } catch { /* ignore */ }
    }
  }
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 5000);
  });
}

function logBoot(scheme, useHttps) {
  console.log(`JV Assistant listening on ${scheme}://0.0.0.0:${config.port}`);
  console.log(
    `Config: model=${config.openaiModel} voice=${config.openaiVoice} twilioConfigured=${Boolean(config.twilioAccountSid && config.twilioAuthToken)} telegram=${Boolean(config.telegramBotToken)} publicBase=${config.publicBaseUrl ? 'set' : 'unset'}`
  );
  if (!config.publicBaseUrl) {
    console.warn('PUBLIC_BASE_URL is unset — set it to the public https origin so Twilio signatures match.');
  }
  console.log(`Voice DID ${JV_TWILIO_DID_E164} → ${config.publicBaseUrl || '<PUBLIC_BASE_URL>'}/twilio/voice`);
  console.log('Do not modify Art +13613360871 or LeadConnector +13616008508.');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const started = createServer();
  started.server.listen(config.port, config.host, () => logBoot(started.useHttps ? 'https' : 'http', started.useHttps));
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    shutdown(started.server, started.bridges, started.scheduler).finally(() => {
      logEvent('shutdown_complete', { signal });
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}
