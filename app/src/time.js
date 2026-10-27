/** America/Chicago date and reminder-time helpers. No I/O. */

export const DEFAULT_TIMEZONE = 'America/Chicago';

export function chicagoYmd(d = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function weekdayName(ymd, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(utc);
}

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const map = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = map.hour === '24' ? 0 : Number(map.hour);
  return {
    ymd: `${map.year}-${map.month}-${map.day}`,
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function ymdToOrdinal(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC Date.
 */
export function wallTimeToUtc(ymd, hour, minute, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  let utcMs = Date.UTC(y, m - 1, d, hour + 6, minute, 0);
  for (let i = 0; i < 4; i++) {
    const got = zonedParts(new Date(utcMs), timeZone);
    const dayDiff = ymdToOrdinal(got.ymd) - ymdToOrdinal(ymd);
    const gotMin = got.hour * 60 + got.minute;
    const wantMin = hour * 60 + minute;
    const diffMin = dayDiff * 1440 + (gotMin - wantMin);
    if (diffMin === 0) break;
    utcMs -= diffMin * 60 * 1000;
  }
  return new Date(utcMs);
}

export function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return chicagoYmd(dt);
}

export function tokenize(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function parseHourMinute(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const ampm = /\b(am|pm)\b/.exec(s);
  const hm = /(\d{1,2})(?::(\d{2}))?/.exec(s);
  if (!hm) return null;
  let hour = Number(hm[1]);
  const minute = hm[2] != null ? Number(hm[2]) : 0;
  if (ampm) {
    if (ampm[1] === 'pm' && hour < 12) hour += 12;
    if (ampm[1] === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parse a when-spec into a UTC Date.
 * Accepts ISO timestamps or phrases like "in 20 minutes", "tomorrow at 3pm", "at 3:00 pm".
 */
export function parseWhen({ whenIso, whenPhrase, now = new Date(), timeZone = DEFAULT_TIMEZONE } = {}) {
  if (whenIso) {
    const d = new Date(whenIso);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'invalid_when_iso' };
    return { ok: true, at: d, source: 'iso' };
  }
  const phrase = String(whenPhrase || '').trim().toLowerCase();
  if (!phrase) return { ok: false, error: 'missing_when' };

  const inRel = /\bin\s+(\d+)\s+(minute|minutes|hour|hours|day|days)\b/.exec(phrase);
  if (inRel) {
    const n = Number(inRel[1]);
    const unit = inRel[2];
    const ms =
      /minute/.test(unit) ? n * 60_000 : /hour/.test(unit) ? n * 3_600_000 : n * 86_400_000;
    return { ok: true, at: new Date(now.getTime() + ms), source: 'relative' };
  }

  const clock = parseHourMinute(phrase);
  if (!clock) return { ok: false, error: 'unparsed_when_phrase' };

  let ymd = chicagoYmd(now, timeZone);
  if (/\btomorrow\b/.test(phrase)) ymd = addDaysYmd(ymd, 1);
  else if (/\btoday\b/.test(phrase)) {
    /* keep today */
  }

  let at = wallTimeToUtc(ymd, clock.hour, clock.minute, timeZone);
  if (!/\btomorrow\b/.test(phrase) && at.getTime() <= now.getTime()) {
    at = wallTimeToUtc(addDaysYmd(ymd, 1), clock.hour, clock.minute, timeZone);
  }
  return { ok: true, at, source: 'clock' };
}

export function retentionCutoffMs(now, retentionDays) {
  const days = Number(retentionDays);
  const n = Number.isFinite(days) && days > 0 ? days : 60;
  return now.getTime() - n * 86_400_000;
}
