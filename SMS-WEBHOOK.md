# JV Assistant SMS — v1 vs Grok Bot calendar/email

## Current (v1) wiring
- Twilio IncomingPhoneNumber **PN54de0290becc61a3020a55a835831bdd** (`+19564684455`)
  - **VoiceUrl** → `https://<this-render-service>/twilio/voice`
  - **SmsUrl** → `https://<this-render-service>/twilio/sms`
- `/twilio/sms` validates Twilio signature, parses Body/From/To, always Telegram-notifies Jason (chat_id `8787733574` via `TELEGRAM_JVASSISTANT_BOT_TOKEN`), and replies with OpenAI (`gpt-4o-mini`) for general questions.
- Calendar/email-style asks are **not** answered from live data in v1 — they escalate via Telegram with an honest SMS ack.

## Parent follow-up: Grok Bot webhook for live calendar/email
Parent already created Grok Bot routine **"JV Assistant SMS"** (folder `jv-assistant-sms`).

When the routine webhook URL is available from the Grok Bot panel:
1. Copy the HTTPS webhook URL.
2. Update Twilio 956 **only**:
   ```
   SmsUrl = <Grok Bot JV Assistant SMS webhook URL>
   SmsMethod = POST
   ```
   Leave **VoiceUrl** on this Render service (`/twilio/voice`).
3. Guide for the Grok Bot routine prompt (already set by parent; keep aligned):
   - Read inbound Twilio SMS payload (`From`, `To`, `Body`, `MessageSid`).
   - Use calendar / email / web connectors to answer when possible.
   - Reply via Twilio Messages API **from** `+19564684455`.
   - Escalate unknowns by Telegram to chat_id `8787733574` and/or text/call Jason `+19564601983`.
   - Never invent private facts.

## Do not touch
- Art DID `+13613360871` / `PNe1c20b7f110eef2171db03c732b9b012`
- Render `bspl-art-voice-agent` (`srv-daous4o0cd8s73b4h6r0`)
