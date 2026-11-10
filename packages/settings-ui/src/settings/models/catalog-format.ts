import type { CatalogLifecycle } from './catalog-projection';

/** "$15", "$2.50", "$0.075": whole dollars bare, cents to two places, finer rates as published. */
export function formatUsd(amount: number): string {
  if (Number.isInteger(amount)) {
    return `$${amount}`;
  }
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) < 1e-9) {
    return `$${amount.toFixed(2)}`;
  }
  // Never `${amount}`: tiny rates would print in exponent form ("$1e-7").
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 20, useGrouping: false })}`;
}

export function pluralNoun(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${pluralNoun(count, singular)}`;
}

const CALENDAR_DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

/** "Apr 1, 2027" for the catalog's `YYYY-MM-DD` day, read in UTC like the catalog writes it. */
export function formatCalendarDay(day: string): string {
  return CALENDAR_DAY_FORMAT.format(new Date(`${day}T00:00:00.000Z`));
}

/** "Archived", "Retires Apr 1, 2027" or "Preview"; nothing for an active model. */
export function lifecycleBadgeLabel(lifecycle: CatalogLifecycle | null): string | null {
  if (lifecycle === null) {
    return null;
  }
  if (lifecycle.archived) {
    return lifecycle.retiresAt === null
      ? 'Archived'
      : `Retires ${formatCalendarDay(lifecycle.retiresAt)}`;
  }
  return lifecycle.status === 'preview' ? 'Preview' : null;
}
