const compactSelectionCountFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
});

export function formatCompactSelectionCount(count: number): string {
  return count >= 1000 ? compactSelectionCountFormatter.format(count) : String(count);
}
