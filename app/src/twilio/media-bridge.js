import WebSocket from 'ws';
import { config } from '../config.js';
import { runWithCallContext } from '../call-context.js';
import { runTool } from '../tools/handlers.js';
import { buildSessionConfig } from '../session.js';
import { callSessionIdForCallSid, normalizeE164, TRANSFER_TARGET_E164 } from './numbers.js';
import { hangupLiveCall } from './transfer.js';
import { logEvent } from './log.js';

const MULAW_FRAME = 160; // 20ms @ 8kHz
const MARK_EVERY_BYTES = 1600; // ~200ms
const INBOUND_FLUSH_MS = 40;
const INBOUND_FLUSH_BYTES = 800; // ~100ms
const MAX_PRESESSION_BYTES = 16000; // ~2s
const HANGUP_AFTER_PLAYBACK_MS = 8000;

export function defaultOpenAIFactory({ model, apiKey }) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

export async function defaultCallerLookup(from) {
  const e164 = normalizeE164(from);
  if (e164 && e164 === TRANSFER_TARGET_E164) {
    return { firstName: 'Jason', lastName: 'Valenzuela', isJason: true };
  }
  return null;
}

export function buildPhoneInstructionsPrefix({ callSid, callSessionId, from, to, caller }) {
  const name = [caller?.firstName, caller?.lastName].filter(Boolean).join(' ').trim();
  const isJason = Boolean(caller?.isJason);
  return [
    '# THIS CALL (PSTN — internal, never read these ids aloud)',
    `callSessionId: ${callSessionId}`,
    `Twilio CallSid: ${callSid}`,
    `Caller ID (From): ${from || 'unknown'}`,
    `Called number (To): ${to || 'unknown'}`,
    isJason
      ? "Caller ID matches Jason Valenzuela's cell. Greet him as Jason. Help with what you can; for calendar/email you cannot see live — take a note via save_message_for_jason (Telegram) rather than inventing."
      : name
        ? `Known caller name hint: ${name}. Use naturally if it fits; if they give a different name, trust the caller.`
        : 'Unknown caller. Ask for their name when you need it.',
    'This is JV Assistant for Jason Valenzuela — personal line, NOT Blueshore Art.',
    'transfer_to_jason dials Jason on this live call. If the tool returns ok:false, apologize and offer save_message_for_jason.',
    'Use end_call when wrapping up.',
  ].join('\n');
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}

/**
 * Bidirectional Twilio Media Streams ↔ OpenAI Realtime.
 * Audio is G.711 μ-law (audio/pcmu) on both sides. No transcoding.
 */
export function createMediaBridge(twilioWs, options = {}) {
  const logger = options.logger || logEvent;
  const openaiFactory = options.openaiFactory || defaultOpenAIFactory;
  const callerLookup = options.callerLookup || defaultCallerLookup;
  const releaseHold = options.releaseHold || (async () => ({ ok: true, skipped: true }));
  const runToolFn = options.runToolFn || runTool;
  const hangupFn = options.hangupFn || hangupLiveCall;
  const inboundFlushMs = options.inboundFlushMs ?? INBOUND_FLUSH_MS;

  const state = {
    streamSid: null,
    callSid: null,
    from: null,
    to: null,
    callSessionId: null,
    openai: null,
    sessionReady: false,
    greeted: false,
    closed: false,
    released: false,
    playEpoch: 0,
    itemId: null,
    outboundRemainder: Buffer.alloc(0),
    outboundBytes: 0,
    playedBytes: 0,
    lastMarkAt: 0,
    markBytes: new Map(),
    preSession: [],
    preSessionBytes: 0,
    inbound: [],
    inboundBytes: 0,
    inboundTimer: null,
    responseActive: false,
    hangupAfterPlayback: false,
    hungUp: false,
    hangupTimer: null,
    seenCalls: new Set(),
  };

  function sendTwilio(obj) {
    if (twilioWs.readyState === WebSocket.OPEN && state.streamSid) {
      twilioWs.send(JSON.stringify(obj));
    }
  }

  function sendOpenAI(obj) {
    if (state.openai && state.openai.readyState === WebSocket.OPEN) {
      state.openai.send(JSON.stringify(obj));
    }
  }

  function context() {
    return {
      channel: 'pstn',
      callSid: state.callSid,
      callSessionId: state.callSessionId,
      from: state.from,
      to: state.to,
    };
  }

  async function release(source) {
    if (state.released || !state.callSessionId) return null;
    state.released = true;
    try {
      const result = await releaseHold({
        callSessionId: state.callSessionId,
        source,
      });
      logger('hold_release', {
        source,
        callSessionId: state.callSessionId,
        callSid: state.callSid,
        ok: Boolean(result?.ok),
        idempotent: Boolean(result?.idempotent),
        paidPreserved: Boolean(result?.paidPreserved),
        error: result?.error || null,
      });
      return result;
    } catch (err) {
      state.released = false;
      logger('hold_release_error', {
        source,
        callSessionId: state.callSessionId,
        message: err?.message || 'release_failed',
      });
      return null;
    }
  }

  function flushInbound() {
    if (state.inboundTimer) {
      clearTimeout(state.inboundTimer);
      state.inboundTimer = null;
    }
    if (!state.sessionReady || state.inbound.length === 0) return;
    const buf = Buffer.concat(state.inbound);
    state.inbound = [];
    state.inboundBytes = 0;
    sendOpenAI({
      type: 'input_audio_buffer.append',
      audio: buf.toString('base64'),
    });
  }

  function queueInbound(payloadB64) {
    let buf;
    try {
      buf = Buffer.from(payloadB64, 'base64');
    } catch {
      return;
    }
    if (!buf.length) return;
    if (!state.sessionReady) {
      if (state.preSessionBytes < MAX_PRESESSION_BYTES) {
        state.preSession.push(buf);
        state.preSessionBytes += buf.length;
      }
      return;
    }
    state.inbound.push(buf);
    state.inboundBytes += buf.length;
    if (state.inboundBytes >= INBOUND_FLUSH_BYTES) {
      flushInbound();
      return;
    }
    if (!state.inboundTimer) {
      state.inboundTimer = setTimeout(flushInbound, inboundFlushMs);
    }
  }

  function flushPreSession() {
    if (!state.preSession.length) return;
    state.inbound.push(...state.preSession);
    state.inboundBytes += state.preSessionBytes;
    state.preSession = [];
    state.preSessionBytes = 0;
    flushInbound();
  }

  function sendFrame(frame, epoch) {
    if (epoch !== state.playEpoch || !state.streamSid) return;
    state.outboundBytes += frame.length;
    sendTwilio({
      event: 'media',
      streamSid: state.streamSid,
      media: { payload: frame.toString('base64') },
    });
    if (state.outboundBytes - state.lastMarkAt >= MARK_EVERY_BYTES) {
      const name = `play-${epoch}-${state.outboundBytes}`;
      state.markBytes.set(name, state.outboundBytes);
      state.lastMarkAt = state.outboundBytes;
      sendTwilio({ event: 'mark', streamSid: state.streamSid, mark: { name } });
    }
  }

  function enqueueOutbound(deltaB64, itemId) {
    if (!deltaB64 || state.closed) return;
    const epoch = state.playEpoch;
    if (itemId) state.itemId = itemId;
    let buf;
    try {
      buf = Buffer.from(deltaB64, 'base64');
    } catch {
      return;
    }
    state.outboundRemainder = Buffer.concat([state.outboundRemainder, buf]);
    while (state.outboundRemainder.length >= MULAW_FRAME) {
      if (epoch !== state.playEpoch) {
        state.outboundRemainder = Buffer.alloc(0);
        return;
      }
      const frame = state.outboundRemainder.subarray(0, MULAW_FRAME);
      state.outboundRemainder = state.outboundRemainder.subarray(MULAW_FRAME);
      sendFrame(frame, epoch);
    }
  }

  function flushRemainderAndFinalMark() {
    const epoch = state.playEpoch;
    if (state.outboundRemainder.length && epoch === state.playEpoch) {
      const rest = state.outboundRemainder;
      state.outboundRemainder = Buffer.alloc(0);
      sendFrame(rest, epoch);
    }
    if (!state.streamSid) return;
    const name = `final-${epoch}`;
    state.markBytes.set(name, state.outboundBytes);
    sendTwilio({ event: 'mark', streamSid: state.streamSid, mark: { name } });
  }

  function bargeIn() {
    const itemId = state.itemId;
    const playedMs = Math.max(0, Math.round(state.playedBytes / 8));
    const wasActive = state.responseActive;
    state.playEpoch += 1;
    state.outboundRemainder = Buffer.alloc(0);
    state.outboundBytes = 0;
    state.playedBytes = 0;
    state.lastMarkAt = 0;
    state.markBytes = new Map();
    state.responseActive = false;
    if (state.streamSid) {
      sendTwilio({ event: 'clear', streamSid: state.streamSid });
    }
    if (itemId) {
      sendOpenAI({
        type: 'conversation.item.truncate',
        item_id: itemId,
        content_index: 0,
        audio_end_ms: playedMs,
      });
    }
    if (wasActive) sendOpenAI({ type: 'response.cancel' });
    logger('barge_in', {
      callSessionId: state.callSessionId,
      playedMs,
      truncated: Boolean(itemId),
    });
  }

  function armHangup() {
    if (state.hangupTimer || state.closed) return;
    state.hangupTimer = setTimeout(() => {
      void finishHangup('playback_timeout');
    }, HANGUP_AFTER_PLAYBACK_MS);
  }

  async function finishHangup(reason) {
    if (state.hungUp || !state.callSid) return;
    state.hungUp = true;
    if (state.hangupTimer) {
      clearTimeout(state.hangupTimer);
      state.hangupTimer = null;
    }
    if (state.closed) return;
    logger('pstn_hangup', { callSessionId: state.callSessionId, callSid: state.callSid, reason });
    try {
      await hangupFn(state.callSid);
    } catch (err) {
      logger('pstn_hangup_error', { callSid: state.callSid, message: err?.message || 'hangup_failed' });
    }
  }

  async function executeFunctionCall(call) {
    const callId = call?.call_id;
    const name = call?.name;
    if (!callId || !name || state.seenCalls.has(callId)) return;
    state.seenCalls.add(callId);
    let args = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      args = {};
    }
    let result;
    try {
      result = await runWithCallContext(context(), () => runToolFn(name, args));
    } catch (err) {
      result = { ok: false, error: 'tool_failed', message: err?.message || 'tool_failed' };
    }
    logger('pstn_tool', {
      callSessionId: state.callSessionId,
      tool: name,
      ok: Boolean(result?.ok),
      error: result?.error || null,
    });
    if (name === 'end_call' && result?.ok) {
      state.hangupAfterPlayback = true;
    }
    const transferred = name === 'transfer_to_jason' && result?.ok === true;
    sendOpenAI({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result ?? { ok: false }),
      },
    });
    if (!transferred) {
      sendOpenAI({ type: 'response.create' });
    }
  }

  function onOpenAIMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = event.type;
    if (type === 'error' || type === 'invalid_request_error') {
      logger('openai_error', {
        callSessionId: state.callSessionId,
        code: event.code || event.error?.code || null,
        message: String(event.message || event.error?.message || '').slice(0, 180),
      });
      return;
    }
    if (type === 'session.updated') {
      state.sessionReady = true;
      flushPreSession();
      if (!state.greeted) {
        state.greeted = true;
        sendOpenAI({ type: 'response.create' });
      }
      return;
    }
    if (type === 'response.created') {
      state.responseActive = true;
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      bargeIn();
      return;
    }
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      state.responseActive = true;
      enqueueOutbound(event.delta, event.item_id);
      return;
    }
    if (type === 'response.output_audio.done' || type === 'response.audio.done') {
      if (event.item_id) state.itemId = event.item_id;
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      void executeFunctionCall({
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments,
      });
      return;
    }
    if (type === 'response.done') {
      state.responseActive = false;
      const output = Array.isArray(event.response?.output) ? event.response.output : [];
      const calls = output.filter((item) => item?.type === 'function_call');
      if (calls.length) {
        for (const call of calls) void executeFunctionCall(call);
        return;
      }
      flushRemainderAndFinalMark();
      if (state.hangupAfterPlayback) armHangup();
      return;
    }
    if (type === 'response.cancelled') {
      state.responseActive = false;
    }
  }

  async function configureSession() {
    const caller = await withTimeout(callerLookup(state.from), 800);
    const prefix = buildPhoneInstructionsPrefix({
      callSid: state.callSid,
      callSessionId: state.callSessionId,
      from: state.from,
      to: state.to,
      caller,
    });
    const session = buildSessionConfig({ phoneAudio: true, instructionsPrefix: prefix });
    sendOpenAI({ type: 'session.update', session });
    logger('openai_session_update', {
      callSessionId: state.callSessionId,
      callSid: state.callSid,
      from: state.from,
      knownCaller: Boolean(caller?.firstName),
      toolCount: Array.isArray(session.tools) ? session.tools.length : 0,
    });
  }

  function openOpenAI() {
    if (!config.openaiApiKey) {
      logger('openai_not_configured', { callSessionId: state.callSessionId });
      try { twilioWs.close(); } catch { /* ignore */ }
      return;
    }
    const ws = openaiFactory({ model: config.openaiModel, apiKey: config.openaiApiKey });
    state.openai = ws;
    ws.on('open', () => {
      void configureSession();
    });
    ws.on('message', onOpenAIMessage);
    ws.on('error', (err) => {
      logger('openai_socket_error', {
        callSessionId: state.callSessionId,
        message: err?.message || 'openai_socket_error',
      });
    });
    ws.on('close', () => {
      logger('openai_socket_close', { callSessionId: state.callSessionId });
    });
  }

  function onStart(msg) {
    const start = msg.start || {};
    const custom = start.customParameters || {};
    state.streamSid = start.streamSid || msg.streamSid || null;
    state.callSid = start.callSid || custom.callSid || null;
    state.from = custom.from || start.from || null;
    state.to = custom.to || start.to || null;
    state.callSessionId = callSessionIdForCallSid(state.callSid);
    logger('twilio_stream_start', {
      callSid: state.callSid,
      callSessionId: state.callSessionId,
      streamSid: state.streamSid,
      from: state.from,
      to: state.to,
      mediaEncoding: start.mediaFormat?.encoding || null,
    });
    if (!state.callSessionId) {
      logger('twilio_stream_invalid_call', { callSid: state.callSid });
      try { twilioWs.close(); } catch { /* ignore */ }
      return;
    }
    openOpenAI();
  }

  function onTwilioMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event === 'connected') {
      logger('twilio_connected', {});
      return;
    }
    if (msg.event === 'start') {
      onStart(msg);
      return;
    }
    if (msg.event === 'media') {
      const payload = msg.media?.payload;
      if (payload && (msg.media?.track === 'inbound' || !msg.media?.track)) {
        queueInbound(payload);
      }
      return;
    }
    if (msg.event === 'mark') {
      const name = msg.mark?.name || '';
      const bytes = state.markBytes.get(name);
      if (bytes != null) state.playedBytes = Math.max(state.playedBytes, bytes);
      if (name.startsWith('final-') && state.hangupAfterPlayback) {
        void finishHangup('playback_complete');
      }
      return;
    }
    if (msg.event === 'stop') {
      logger('twilio_stream_stop', { callSessionId: state.callSessionId, callSid: state.callSid });
      close('stop');
    }
  }

  function close(reason) {
    if (state.closed) return;
    state.closed = true;
    if (state.inboundTimer) clearTimeout(state.inboundTimer);
    if (state.hangupTimer) clearTimeout(state.hangupTimer);
    try { state.openai?.close(); } catch { /* ignore */ }
    try {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch { /* ignore */ }
    void release(reason === 'stop' ? 'websocket_disconnect' : 'websocket_disconnect');
    logger('twilio_socket_closed', {
      callSessionId: state.callSessionId,
      callSid: state.callSid,
      reason: reason || 'close',
    });
  }

  twilioWs.on('message', onTwilioMessage);
  twilioWs.on('close', () => close('close'));
  twilioWs.on('error', (err) => {
    logger('twilio_socket_error', {
      callSessionId: state.callSessionId,
      message: err?.message || 'twilio_socket_error',
    });
  });

  return {
    close: () => close('close'),
    get callSessionId() {
      return state.callSessionId;
    },
  };
}
