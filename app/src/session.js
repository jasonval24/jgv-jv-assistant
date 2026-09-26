import { config, loadCanonicalPrompt } from './config.js';
import { toolDefinitions } from './tools/definitions.js';

function chicagoNowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
}

export function buildInstructions() {
  const base = loadCanonicalPrompt();
  const p = chicagoNowParts();
  const clock = `# CLOCK (internal only — America/Chicago)
Today is **${p.weekday}, ${p.month} ${p.day}, ${p.year}**. Local time about ${p.hour}:${p.minute} ${p.dayPeriod}.
Use resolve_calendar quietly when you need a date. Speak natural dates — never narrate calendar math. Never say CT/Central Time out loud unless Jason asks.
`;
  return `${clock}\n\n${base}`;
}

export function buildSessionConfig(options = {}) {
  const instructions = options.instructionsPrefix
    ? `${String(options.instructionsPrefix).trim()}\n\n${buildInstructions()}`
    : buildInstructions();
  const audio = {
    input: {
      transcription: { model: 'gpt-4o-mini-transcribe' },
    },
    output: {
      voice: config.openaiVoice,
    },
  };
  if (options.phoneAudio) {
    audio.input.format = { type: 'audio/pcmu' };
    audio.input.turn_detection = {
      type: 'server_vad',
      create_response: true,
      interrupt_response: true,
    };
    audio.output.format = { type: 'audio/pcmu' };
  }
  const session = {
    type: 'realtime',
    model: config.openaiModel,
    instructions,
    audio,
    tools: toolDefinitions,
    tool_choice: 'auto',
  };
  if (options.phoneAudio) session.output_modalities = ['audio'];
  return session;
}

export async function createClientSecret() {
  const session = buildSessionConfig();
  const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': 'jgv-jv-assistant',
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`OpenAI client_secrets → ${res.status}`);
    err.status = res.status;
    err.details = { status: res.status, error: data.error || data };
    throw err;
  }
  return data;
}
