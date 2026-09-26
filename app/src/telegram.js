import { config, redact } from './config.js';

/**
 * Send a Telegram message to Jason's JV Assistant chat.
 * Prefers TELEGRAM_JVASSISTANT_BOT_TOKEN (loaded into config.telegramBotToken).
 */
export async function notifyJason(text, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;
  if (!token) {
    console.log('[telegram] skipped — no bot token', JSON.stringify(redact({ chatId })));
    return { ok: false, error: 'missing_telegram_token' };
  }
  if (!chatId) {
    return { ok: false, error: 'missing_telegram_chat_id' };
  }
  const body = String(text || '').slice(0, 3900);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: body,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      console.error('[telegram] send failed', res.status, redact({ description: data.description }));
      return { ok: false, error: 'telegram_send_failed', status: res.status };
    }
    return { ok: true, messageId: data.result?.message_id || null };
  } catch (err) {
    console.error('[telegram] network', err?.message || err);
    return { ok: false, error: 'network', message: err?.message || 'network_error' };
  }
}
