// Business-day arithmetic for SLA timers. Everything is UTC; the holiday list is data the office owns.
export type Calendar = { holidays: ReadonlySet<string> };      // 'YYYY-MM-DD'

export function isBusinessDay(d: Date, cal: Calendar): boolean {
  const weekday = d.getUTCDay();                                  // 0 = Sunday, 6 = Saturday
  return weekday !== 0 && weekday !== 6 && !cal.holidays.has(d.toISOString().slice(0, 10));
}

/** n business days after `from`, same time of day. A Saturday start counts from the next business day. */
export function addBusinessDays(from: Date, n: number, cal: Calendar): Date {
  const d = new Date(from);
  for (let left = n; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d, cal)) left--;
  }
  return d;
}

/** The planted fault: the same call, counting every day. */
export function addCalendarDays(from: Date, n: number, _cal: Calendar): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
