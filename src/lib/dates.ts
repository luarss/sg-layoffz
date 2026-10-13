export const DAY_MS = 86_400_000;

function toMs(date: string | Date): number {
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}

export function daysBetween(a: string | Date, b: string | Date): number {
  return Math.abs(toMs(a) - toMs(b)) / DAY_MS;
}

export function withinDays(a: string | Date, b: string | Date, days: number): boolean {
  return daysBetween(a, b) <= days;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthOf(date: string | Date): string {
  if (date instanceof Date) return date.toISOString().slice(0, 7);
  return (date || '').slice(0, 7);
}
