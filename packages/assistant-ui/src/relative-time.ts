const RELATIVE_TIME_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

// Building an Intl formatter is expensive; hoist a single shared instance.
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** How long before `now` a past moment was, e.g. "5 minutes ago", "yesterday". */
export function formatRelativeTime(timestampMs: number, now: number): string {
  const elapsedMs = Math.max(0, now - timestampMs);
  for (const [unit, unitMs] of RELATIVE_TIME_UNITS) {
    if (elapsedMs >= unitMs) {
      return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / unitMs), unit);
    }
  }
  return RELATIVE_TIME_FORMATTER.format(-Math.floor(elapsedMs / 1000), 'second');
}

/** The full local date and time, e.g. "5 Nov 2026, 14:32". */
export function formatAbsoluteTime(timestampMs: number): string {
  return ABSOLUTE_TIME_FORMATTER.format(timestampMs);
}
