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
