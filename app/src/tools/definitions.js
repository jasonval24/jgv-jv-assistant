/** OpenAI Realtime tool schemas for JV Assistant (personal — no Blueshore booking). */

const phoneConsentProps = {
  jason_explicit_request: {
    type: 'boolean',
    description:
      'Must be true only when Jason just told you in THIS conversation to place this call or send this text (or you are firing a reminder he set). Never true for guesses or implied wants.',
  },
  jason_request_quote: {
    type: 'string',
    description: "Short quote or paraphrase of Jason's instruction (e.g. 'text Mom I am running late').",
  },
};

export const toolDefinitions = [
  {
    type: 'function',
    name: 'transfer_to_jason',
    description:
      'Warm-transfer the live caller to Jason Valenzuela. Use when the caller asks for Jason, for sensitive/private matters, complaints, or anything you cannot handle confidently.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason for the transfer' },
        caller_name: { type: 'string' },
        caller_phone: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    type: 'function',
    name: 'call_jason',
    description:
      'Place a new outbound call to Jason (number from config) when you are unsure and must not guess, or when he asked you to call him. Prefer this over inventing private facts. Not a warm-transfer of the current caller — this dials Jason from the JV line.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What you need Jason to decide or confirm. Spoken to him on the call.',
        },
        reason: { type: 'string', description: 'Why you are escalating' },
        jason_explicit_request: phoneConsentProps.jason_explicit_request,
        jason_request_quote: phoneConsentProps.jason_request_quote,
      },
      required: ['question'],
    },
  },
  {
    type: 'function',
    name: 'deliver_message_call',
    description:
      'Call any number Jason named and speak the exact message he dictated, then report answered / voicemail / no answer and any reply. Only when Jason explicitly asked in this conversation (or a reminder he set).',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination phone number' },
        message: { type: 'string', description: 'Exact message Jason wants spoken' },
        ...phoneConsentProps,
      },
      required: ['to', 'message', 'jason_explicit_request'],
    },
  },
  {
    type: 'function',
    name: 'place_call',
    description:
      'Place a general-purpose outbound conversation call to a number Jason named, following his instructions. Only when Jason explicitly asked in this conversation. Use deliver_message_call when he wants a specific script spoken.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination phone number' },
        instructions: { type: 'string', description: "What Jason wants you to do or say on the call" },
        ...phoneConsentProps,
      },
      required: ['to', 'instructions', 'jason_explicit_request'],
    },
  },
  {
    type: 'function',
    name: 'send_sms',
    description:
      'Send an SMS from the JV line. Jason can text himself or any number he names, with the content he specifies. Only when he explicitly asked in this conversation or via a reminder he set. Never autonomous third-party texts.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Destination phone number (Jason or someone he named)' },
        body: { type: 'string', description: 'Exact text to send' },
        ...phoneConsentProps,
      },
      required: ['to', 'body', 'jason_explicit_request'],
    },
  },
  {
    type: 'function',
    name: 'schedule_reminder',
    description:
      'Persist a future reminder: call Jason, text Jason, or text another number with content Jason specified. Survives restarts. Only when Jason explicitly asked.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['call_jason', 'sms_jason', 'sms_other'],
          description: 'call_jason = call him; sms_jason = text him; sms_other = text a number he named',
        },
        to: { type: 'string', description: 'Required for sms_other; ignored for Jason channels (uses JASON_CELL)' },
        content: { type: 'string', description: 'Reminder text or SMS body' },
        when_iso: { type: 'string', description: 'ISO-8601 timestamp if already resolved' },
        when_phrase: { type: 'string', description: 'e.g. "tomorrow at 3pm", "in 20 minutes"' },
        ...phoneConsentProps,
      },
      required: ['channel', 'content', 'jason_explicit_request'],
    },
  },
  {
    type: 'function',
    name: 'list_reminders',
    description: 'List pending reminders Jason has set.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'remember',
    description:
      'Persist a decision, action item, or key statement from this conversation (dated) so Jason can recall it later.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        action_items: { type: 'array', items: { type: 'string' } },
        key_statements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              speaker: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'recall_memory',
    description:
      "Search the last 30–60 days of persisted decisions, action items, and key statements. Use when Jason asks e.g. 'last month when we did X, what did we decide?' Return the decision, what was said, and the date / call reference.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What Jason is asking about' },
        retention_days: { type: 'number', description: 'Override window; default is MEMORY_RETENTION_DAYS (60)' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'list_recent_calls',
    description: 'List recent Twilio calls on this account (CallSid, times, status). Does not start a new recording.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max rows (default 15)' } },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_call_transcript',
    description:
      'Fetch a past call transcript from Twilio: Voice Intelligence if configured, else recording transcription, else transcribe the Twilio recording audio. Do not start a new recording.',
    parameters: {
      type: 'object',
      properties: { call_sid: { type: 'string', description: 'Twilio CallSid (CAxxx)' } },
      required: ['call_sid'],
    },
  },
  {
    type: 'function',
    name: 'search_call_transcripts',
    description:
      'Search recent Twilio call transcripts for what was discussed earlier. Uses existing Twilio recordings / Voice Intelligence only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        since_days: { type: 'number', description: 'Look-back window (default memory retention)' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'save_message_for_jason',
    description:
      'Take a message for Jason and notify him immediately via Telegram. Use when the caller wants to leave a message, or when you cannot answer and transfer is not appropriate.',
    parameters: {
      type: 'object',
      properties: {
        caller_name: { type: 'string' },
        caller_phone: { type: 'string' },
        message: { type: 'string', description: 'The message content to deliver to Jason' },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'How urgent this is for Jason',
        },
      },
      required: ['message'],
    },
  },
  {
    type: 'function',
    name: 'web_search',
    description:
      'Look up public factual information on the web (news, general knowledge, business hours that are public, etc.). Do NOT use for Jason private calendar/email — escalate those instead. Quote only what the tool returns; never invent facts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'resolve_calendar',
    description:
      'Resolve relative date phrases to America/Chicago calendar dates (e.g. "next Friday"). Call before naming a calendar date. Never invent weekdays.',
    parameters: {
      type: 'object',
      properties: {
        phrase: { type: 'string' },
        date: { type: 'string', description: 'Optional ISO YYYY-MM-DD to label' },
        dates: { type: 'array', items: { type: 'string' } },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description:
      'End the call after a short goodbye. Writes a local transcript/summary, persists memory (decisions / action items / key statements), and optionally notifies Jason via Telegram. Call when the conversation is wrapping up.',
    parameters: {
      type: 'object',
      properties: {
        caller_phone: { type: 'string' },
        caller_name: { type: 'string' },
        summary: { type: 'string', description: '2–5 sentence call summary' },
        transcript: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        action_items: { type: 'array', items: { type: 'string' } },
        key_statements: {
          type: 'array',
          items: {
            type: 'object',
            properties: { speaker: { type: 'string' }, text: { type: 'string' } },
          },
        },
        notify_jason: {
          type: 'boolean',
          description: 'If true, Telegram Jason with the summary (default true for non-trivial calls)',
        },
      },
      required: ['summary'],
    },
  },
];

export const SMS_JASON_TOOL_NAMES = new Set([
  'save_message_for_jason',
  'web_search',
  'resolve_calendar',
  'deliver_message_call',
  'place_call',
  'call_jason',
  'send_sms',
  'schedule_reminder',
  'list_reminders',
  'cancel_reminder',
  'remember',
  'recall_memory',
  'list_recent_calls',
  'get_call_transcript',
  'search_call_transcripts',
]);

export const INBOUND_OTHER_TOOL_NAMES = new Set([
  'transfer_to_jason',
  'call_jason',
  'save_message_for_jason',
  'web_search',
  'resolve_calendar',
  'end_call',
  'remember',
]);

export function toChatTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}
