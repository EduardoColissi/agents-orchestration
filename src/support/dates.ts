/** Date helpers working on business-local calendar dates (YYYY-MM-DD). */

export const BUSINESS_TIMEZONE = 'America/Sao_Paulo';

export function localDate(now: Date, timeZone = BUSINESS_TIMEZONE): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** Adds business days (Mon–Fri). Bank holidays are out of scope for the mock. */
export function addBusinessDays(date: string, days: number): string {
  if (days === 0) return date;
  let current = date;
  let remaining = days;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (!isWeekend(current)) remaining--;
  }
  return current;
}

export function weekdayName(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}
