/** Fallback type label for files without a recognized extension. */
export const EXTENSIONLESS_FILE_TYPE = 'file';

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Adaptive file-size formatter for the explorer's Size cells.
 * Sub-kilobyte sizes render in whole bytes (a KB-only scale rendered every
 * small file as "0.0 KB"); larger sizes step through KB/MB/GB/TB with one
 * decimal. `undefined` renders the unavailable dash.
 */
export function formatFileSize(bytes?: number): string {
  if (bytes === undefined) {
    return '—';
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  let size = bytes;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
}

/** Compact token count for the explorer's Tokens cells and meter: "512", "1.2K", "3.4M". */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
