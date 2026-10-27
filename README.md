# jgv-jv-assistant

**JV Assistant** — personal SMS + voice assistant for Jason Valenzuela on Twilio `+19564684455`.

Not Blueshore Art. Do not reconfigure `+13613360871`.

Modeled after a PEO-style voice office: this service is the voice/SMS agent. It can hand calendar/email-style work to the **Maria Botello · JGV Personal Assistant** Grok Bot. It is **not** `jasonval24/jgv-personal-assistant`.

## Stack
- Twilio Media Streams → OpenAI Realtime (voice)
- Twilio SMS webhook → OpenAI chat + tools (when Jason texts) + Telegram notify
- Tools: transfer / escalate to Jason, deliver-message and conversation calls, SMS, reminders, 30–60 day memory recall, Twilio call list + transcript search, `web_search`, `resolve_calendar`, `end_call`

## Phone rules
- Call/SMS is general-purpose (any number Jason names).
- Outreach happens only when Jason explicitly asks in the current conversation, or when a reminder he set fires. No autonomous third-party texts or calls.
- `call_jason` dials Jason when the agent is unsure (number from `JASON_CELL` / `TRANSFER_TO_JASON`, never hardcoded).
- Third-party outbound calls use Twilio's existing call recording from the start. This service does **not** add a second recorder.
- Outbound caller ID is `TWILIO_VOICE_NUMBER` (the 4455 JV line).

## Persistence
Reminders and conversation memory are JSON files under `DATA_DIR` (default `app/data`). Render's disk is ephemeral unless you attach a **persistent disk** and set `DATA_DIR` to the mount path. Without that, data survives process restarts on the same instance but not deploys or spin-down.

## Env vars (names only)

Existing: `PORT`, `HOST`, `PUBLIC_BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VOICE_NUMBER`, `TRANSFER_TO_JASON`, `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_VOICE`, `OPENAI_CHAT_MODEL`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_JVASSISTANT_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OUTBOUND_CALL_SECRET`, family-call vars (`ANNA_PHONE`, `ANNA_CALLS`, `JASON_OUTBOUND_CALLS`, `ROUTINE_URL`, `ROUTINE_KEY`).

New / required for these features:

| Name | Purpose |
| --- | --- |
| `JASON_CELL` | Jason's cell (optional if `TRANSFER_TO_JASON` is set). Used for escalate-to-Jason and "is this Jason?" |
| `DATA_DIR` | Directory for `memory.json`, `reminders.json`, `jobs.json`. Put this on a Render disk. |
| `MEMORY_RETENTION_DAYS` | Recall window (default 60; use 30–60). |
| `JASON_TIMEZONE` | Default `America/Chicago` for reminders and memory dates. |
| `REMINDER_POLL_SECONDS` | How often due reminders are checked (default 20). |
| `TWILIO_VOICE_INTELLIGENCE_SID` | Conversational Intelligence / Voice Intelligence **Service SID** (`GAxxx`) so past-call lookup can fetch official transcripts. |

Never put Twilio auth tokens or API keys in logs, git, or this file.

## Jason setup
1. Set `JASON_CELL` or keep `TRANSFER_TO_JASON` (Jason's cell). Do not hardcode it in source.
2. Attach a Render persistent disk and set `DATA_DIR` if reminders/memory must survive deploys.
3. Optional: create a Twilio Conversational Intelligence (Voice Intelligence) service and set `TWILIO_VOICE_INTELLIGENCE_SID`. If unset, the agent still lists Twilio calls and uses recording transcriptions, or transcribes the Twilio recording audio with OpenAI. Confirm Twilio account-level or per-call **Record** is already on — do not add a separate recorder.
4. Keep `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `OPENAI_API_KEY` configured (secrets). Do not print them.

## Health
`GET /health`

## Tests
```bash
cd app && npm test
```
