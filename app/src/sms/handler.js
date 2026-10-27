import { config, loadCanonicalPrompt, redact } from '../config.js';
import { isJasonCaller, normalizeE164 } from '../twilio/numbers.js';
import { notifyJason } from '../telegram.js';
import { logEvent } from '../twilio/log.js';
import { runWithCallContext } from '../call-context.js';
import { runTool } from '../tools/handlers.js';
import { SMS_JASON_TOOL_NAMES, toChatTools, toolDefinitions } from '../tools/definitions.js';

const SMS_SYSTEM = () => `${loadCanonicalPrompt()}

# SMS CHANNEL
You are responding over SMS from Jason's personal number (956) 468-4455.
Keep replies short (1–3 short sentences). Plain text only — no markdown.
If the sender is Jason (his cell): help with general questions; you may call, text, schedule reminders, recall memory, and search past Twilio calls — but only when he explicitly asks in this thread. If you are unsure of a private fact, use call_jason instead of guessing.
If the sender is someone else: answer public questions briefly, offer to take a message for Jason, do not invent private facts. Never place a call or send a text to a third party.
When you cannot help, say you'll pass it to Jason.
`;

/**
 * Handle inbound Twilio SMS.
 * Returns { reply: string|null, telegramNotified: boolean }.
 */
export async function handleInboundSms({ from, to, body, messageSid }) {
  const fromE164 = normalizeE164(from);
  const isJason = isJasonCaller(fromE164 || from);
  const text = String(body || '').trim();

  logEvent('sms_inbound', {
    from: fromE164,
    to: normalizeE164(to),
    messageSid,
    isJason,
    bodyLen: text.length,
  });

  const tg = await notifyJason(
    `💬 JV Assistant SMS inbound\nFrom: ${fromE164 || from || 'unknown'}${isJason ? ' (Jason)' : ''}\nTo: ${normalizeE164(to) || to}\nBody: ${text.slice(0, 1500) || '(empty)'}`
  );

  if (!text) {
    return {
      reply: 'Got your blank text — reply with a message and I will help or pass it to Jason.',
      telegramNotified: tg.ok === true,
    };
  }

  const needsLiveData =
    /\b(calendar|schedule|agenda|inbox|email|e-mail|reschedul|appointment|meeting|what'?s on my)\b/i.test(
      text
    );

  if (needsLiveData) {
    const reply = isJason
      ? "On it — I don't have live calendar/email in this channel yet, so I just pinged you on Telegram with the ask. Fuller calendar/email comes when SmsUrl points at the Grok Bot webhook."
      : "I can take a message for Jason or have him get back to you — I don't share his private calendar or email. Want me to pass something along?";
    return { reply, telegramNotified: tg.ok === true, escalated: true };
  }

  if (!config.openaiApiKey) {
    const reply = isJason
      ? 'JV Assistant is online, but OpenAI is not configured yet. Your text was forwarded to Telegram.'
      : "Thanks — I've notified Jason. He'll get back to you soon.";
    return { reply, telegramNotified: tg.ok === true };
  }

  try {
    const messages = [
      { role: 'system', content: SMS_SYSTEM() },
      {
        role: 'user',
        content: `Sender: ${fromE164 || from}${isJason ? ' (this is Jason himself)' : ''}\nSMS: ${text}`,
      },
    ];
    const tools = isJason
      ? toChatTools(toolDefinitions.filter((t) => SMS_JASON_TOOL_NAMES.has(t.name)))
      : undefined;
    let reply = '';
    for (let i = 0; i < 4; i++) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.openaiChatModel,
          temperature: 0.4,
          max_tokens: 280,
          messages,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
        }),
        signal: AbortSignal.timeout(25000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.error('[sms] openai error', res.status, redact({ error: data.error }));
        return {
          reply: isJason
            ? 'Got it — forwarded to Telegram. (AI reply briefly unavailable.)'
            : "Thanks — I've let Jason know. He'll follow up.",
          telegramNotified: tg.ok === true,
        };
      }
      const msg = data.choices?.[0]?.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) {
        reply = String(msg.content || '').trim();
        break;
      }
      messages.push(msg);
      for (const call of calls) {
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        const toolResult = await runWithCallContext(
          { channel: 'sms', from: fromE164 || from, actor: isJason ? 'jason' : 'other' },
          () => runTool(call.function?.name, args)
        );
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(toolResult ?? { ok: false }),
        });
      }
    }
    if (!reply) {
      reply = isJason
        ? 'Got it — noted on Telegram.'
        : "Thanks — I've notified Jason.";
    }
    if (reply.length > 1200) reply = `${reply.slice(0, 1190)}…`;
    return { reply, telegramNotified: tg.ok === true };
  } catch (err) {
    console.error('[sms] handler error', err?.message || err);
    return {
      reply: "Thanks — I've notified Jason. He'll get back to you.",
      telegramNotified: tg.ok === true,
    };
  }
}
