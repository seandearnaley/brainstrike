/** Compact "1M context" / "200K context" badge copy for model rows. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M context`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K context`;
  }
  return `${tokens} context`;
}
