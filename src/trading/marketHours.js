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

export async function waitForMarketOpen(client, log = console.log) {
  for (;;) {
    const clock = await client.getClock();
    if (clock.is_open) return clock;
    const next = new Date(clock.next_open);
    log(`Market closed. Next open: ${formatEt(next)} ET`);
    const sleepMs = Math.min(60_000, Math.max(5000, next - Date.now()));
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}
