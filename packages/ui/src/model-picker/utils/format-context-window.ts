/**
 * Compact token count ("1.1M", "200K", "512") shared by every model-facts
 * surface — the composer badge and the Model Catalog columns — so the two can
 * never disagree about how a number is rounded.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return `${tokens}`;
}

/** Compact "1M context" / "200K context" badge copy for model rows. */
export function formatContextWindow(tokens: number): string {
  return `${formatTokenCount(tokens)} context`;
}
