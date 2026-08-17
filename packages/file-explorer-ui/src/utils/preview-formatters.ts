const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * Adaptive file-size formatter for preview/grid Size cells.
 * Sub-kilobyte sizes render in whole bytes (a KB-only scale rendered every
 * small file as "0.0 KB"); larger sizes step through KB/MB/GB/TB with one
 * decimal. `undefined` renders the unavailable dash.
 */
export function formatPreviewFileSize(bytes?: number): string {
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
