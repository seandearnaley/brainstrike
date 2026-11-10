import type {
  CatalogLifecycle,
  CatalogLongContextTier,
  CatalogPricing,
  CatalogRates,
} from './catalog-projection';

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

const CALENDAR_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

/** "Jun 2026" for a `YYYY-MM` cutoff, "Sep 30, 2024" for a `YYYY-MM-DD` one. */
export function formatKnowledgeCutoff(cutoff: string): string {
  return cutoff.length === 7
    ? CALENDAR_MONTH_FORMAT.format(new Date(`${cutoff}-01T00:00:00.000Z`))
    : formatCalendarDay(cutoff);
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

/** One priced token class: a Model Catalog rate column. */
export type CatalogRate = 'cacheRead' | 'cacheWrite' | 'input' | 'output';

export const CATALOG_RATE_LABELS = {
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  input: 'input',
  output: 'output',
} as const satisfies Record<CatalogRate, string>;

/** The rate, or `null` when it isn't published (a tier's `null` cache rate means "the base rate"). */
export function rateOf(
  rates: CatalogLongContextTier | CatalogRates,
  rate: CatalogRate
): number | null {
  switch (rate) {
    case 'cacheRead':
      return rates.cacheReadPerMTok;
    case 'cacheWrite':
      return rates.cacheWritePerMTok;
    case 'input':
      return rates.inputPerMTok;
    case 'output':
      return rates.outputPerMTok;
    default: {
      const exhaustive: never = rate;
      throw new Error(`Unknown catalog rate: ${String(exhaustive)}`);
    }
  }
}

/** Free only when both input and output cost nothing; one zero rate is still a price. */
export function isFreePricing(pricing: CatalogRates): boolean {
  return pricing.inputPerMTok === 0 && pricing.outputPerMTok === 0;
}

const fullNumber = new Intl.NumberFormat('en-US');

/** "272,000": the exact prompt length a long-context tier starts at. */
export function formatPromptTokens(tokens: number): string {
  return fullNumber.format(tokens);
}

/** Why one rate cell isn't the whole story: its long-context tiers and its announced change. */
export interface CatalogRateNotes {
  /** "From Dec 1, 2026: $4", or "No published rate from …" when the change leaves it out. */
  readonly change: string | null;
  /** "From 272,000 prompt tokens: $10", one per tier that raises this rate. */
  readonly tiers: readonly string[];
}

export function rateNotes(pricing: CatalogPricing, rate: CatalogRate): CatalogRateNotes {
  const base = rateOf(pricing, rate);
  const tiers = pricing.longContextTiers.flatMap((tier) => {
    const value = rateOf(tier, rate);
    return value === null || value === base
      ? []
      : [`From ${formatPromptTokens(tier.minPromptTokens)} prompt tokens: ${formatUsd(value)}`];
  });
  const { nextChange } = pricing;
  let change: string | null = null;
  if (nextChange !== null) {
    const next = rateOf(nextChange, rate);
    const day = formatCalendarDay(nextChange.effectiveFrom);
    if (next === null && base !== null) {
      change = `No published rate from ${day}`;
    } else if (next !== null && next !== base) {
      change = `From ${day}: ${formatUsd(next)}`;
    }
  }
  return { change, tiers };
}
