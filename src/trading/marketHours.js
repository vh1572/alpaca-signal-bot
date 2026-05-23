const NY = 'America/New_York';

export function toEtParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

export function isWeekdayEt(date) {
  const { weekday } = toEtParts(date);
  return weekday !== 'Sat' && weekday !== 'Sun';
}

/** Regular session 9:30–16:00 ET */
export function isRegularSessionEt(date) {
  if (!isWeekdayEt(date)) return false;
  const { hour, minute } = toEtParts(date);
  const mins = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return mins >= open && mins < close;
}

export function minutesUntilCloseEt(date) {
  const { hour, minute } = toEtParts(date);
  const mins = hour * 60 + minute;
  const close = 16 * 60;
  return Math.max(0, close - mins);
}

export function shouldFlattenEod(date, eodCloseMin) {
  return isRegularSessionEt(date) && minutesUntilCloseEt(date) <= eodCloseMin;
}

export function msUntilNextInterval(date, intervalMin) {
  const ms = intervalMin * 60 * 1000;
  const next = Math.ceil(date.getTime() / ms) * ms;
  return Math.max(1000, next - date.getTime());
}

export function formatEt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: NY,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

/** Deterministic per-symbol delay to spread API calls across many instances. */
export function symbolJitterMs(symbol, maxMs) {
  if (!symbol || maxMs <= 0) return 0;
  let h = 0;
  for (let i = 0; i < symbol.length; i++) {
    h = (Math.imul(31, h) + symbol.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % maxMs;
}

/**
 * Ms to sleep until wakeBeforeMin minutes before next_open, plus per-symbol jitter.
 */
export function msUntilMarketWake(
  nextOpenIso,
  symbol,
  { wakeBeforeMin = 2, jitterMaxSec = 180 } = {},
) {
  const wakeBeforeMs = wakeBeforeMin * 60 * 1000;
  const jitter = symbolJitterMs(symbol, jitterMaxSec * 1000);
  const target = new Date(nextOpenIso).getTime() - wakeBeforeMs + jitter;
  return Math.max(0, target - Date.now());
}

export function formatDuration(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** @deprecated Use msUntilMarketWake + sleep in monitor; kept for compatibility. */
export async function waitForMarketOpen(client, log = console.log) {
  const clock = await client.getClock();
  if (clock.is_open) return clock;
  const sleepMs = msUntilMarketWake(clock.next_open, '');
  log(`Market closed. Next open: ${formatEt(new Date(clock.next_open))} ET`);
  await new Promise((r) => setTimeout(r, sleepMs));
  for (;;) {
    const c = await client.getClock();
    if (c.is_open) return c;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}
