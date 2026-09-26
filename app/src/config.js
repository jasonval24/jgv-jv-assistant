import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
export const APP_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(APP_ROOT, '.env') });

function loadBoxSecret(key) {
  try {
    const p = '/home/box/agent-data/box-secrets.json';
    if (!fs.existsSync(p)) return undefined;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const card = data.card || data;
    return card[key];
  } catch {
    return undefined;
  }
}

export const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || '0.0.0.0',
  openaiApiKey: process.env.OPENAI_API_KEY || loadBoxSecret('OPENAI_API_KEY') || '',
  openaiModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
  openaiChatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini',
  openaiVoice: process.env.OPENAI_VOICE || 'verse',
  transferToJason: process.env.TRANSFER_TO_JASON || '+19564601983',
  /** Personal DID — JV Assistant McAllen 956. Never the Art 361 number. */
  twilioVoiceNumber: process.env.TWILIO_VOICE_NUMBER || '+19564684455',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  promptPath: path.join(ROOT, 'jv-assistant-prompt.md'),
  transcriptsDir: path.join(APP_ROOT, 'transcripts'),
  telegramBotToken:
    process.env.TELEGRAM_JVASSISTANT_BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    loadBoxSecret('TELEGRAM_JVASSISTANT_BOT_TOKEN') ||
    loadBoxSecret('TELEGRAM_BOT_TOKEN') ||
    '',
  telegramChatId: String(process.env.TELEGRAM_CHAT_ID || '8787733574'),
  jasonCell: '+19564601983',
  serviceName: 'jgv-jv-assistant',
};

export function loadCanonicalPrompt() {
  return fs.readFileSync(config.promptPath, 'utf8').trim();
}

/** Redact secrets from any object before logging */
export function redact(obj) {
  const SENSITIVE =
    /api[_-]?key|token|secret|authorization|bearer|password|source[_]?id|sourceId|card|pan|cvv|cvc|nonce|pay[_-]?url|payload|audio|delta|signature|cookie|media/i;
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) {
      out[k] = typeof v === 'string' && v.length ? `[redacted len=${v.length}]` : '[redacted]';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
