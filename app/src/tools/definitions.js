/** OpenAI Realtime tool schemas for JV Assistant (personal — no Blueshore booking). */
export const toolDefinitions = [
  {
    type: 'function',
    name: 'transfer_to_jason',
    description:
      'Warm-transfer the live caller to Jason Valenzuela at +1 956-460-1983. Use when the caller asks for Jason, for sensitive/private matters, complaints, or anything you cannot handle confidently.',
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
      'End the call after a short goodbye. Writes a local transcript/summary and optionally notifies Jason via Telegram with the summary. Call when the conversation is wrapping up.',
    parameters: {
      type: 'object',
      properties: {
        caller_phone: { type: 'string' },
        caller_name: { type: 'string' },
        summary: { type: 'string', description: '2–5 sentence call summary' },
        transcript: { type: 'string' },
        notify_jason: {
          type: 'boolean',
          description: 'If true, Telegram Jason with the summary (default true for non-trivial calls)',
        },
      },
      required: ['summary'],
    },
  },
];
