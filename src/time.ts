// Mauritius time is UTC+4 all year (no daylight saving). Every "now", window and
// date in the app goes through these helpers, and every caller passes `now` in.

export const MU_OFFSET_MS = 4 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface MuParts {
  /** YYYY-MM-DD in Mauritius. */
  date: string;
  hour: number;
  minute: number;
  weekday: string;
  /** "Thursday 15 October 2026" */
  longDate: string;
}

export function muParts(ms: number): MuParts {
  const d = new Date(ms + MU_OFFSET_MS);
  const weekday = WEEKDAYS[d.getUTCDay()] ?? "";
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday,
    longDate: `${weekday} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
  };
}

/** The instant (UTC ms) of `hour`:00 on a Mauritius date. */
export function muInstant(date: string, hour: number): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hour) - MU_OFFSET_MS;
}

export function addDays(date: string, days: number): string {
  return new Date(muInstant(date, 12) + MU_OFFSET_MS + days * DAY_MS).toISOString().slice(0, 10);
}

/** ISO 8601 with the +04:00 offset, e.g. 2026-10-15T14:00:00+04:00. */
export function isoMu(ms: number): string {
  return new Date(ms + MU_OFFSET_MS).toISOString().slice(0, 19) + "+04:00";
}

/** "14:05" in Mauritius. */
export function hhmmMu(ms: number): string {
  return new Date(ms + MU_OFFSET_MS).toISOString().slice(11, 16);
}

export function hourOfMu(ms: number): number {
  return new Date(ms + MU_OFFSET_MS).getUTCHours();
}

export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export { HOUR_MS };
