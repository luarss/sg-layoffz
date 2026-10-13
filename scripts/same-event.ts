import { withinDays } from '../src/lib/dates';

export const AUTO_LINK_WINDOW_DAYS = 7;

export const SAME_EVENT_WINDOW_DAYS = 21;

export const DOUBLE_COUNT_REVIEW_WINDOW_DAYS = 31;

export function sameEventWindow(a: string, b: string, days = SAME_EVENT_WINDOW_DAYS): boolean {
  return withinDays(a, b, days);
}
