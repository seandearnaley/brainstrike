export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Display-side helper: empty input intentionally falls through to
// `new Date('').toLocaleString()` which yields "Invalid Date" — surfacing the
// bad input visibly. CSV export uses a separate sibling that maps empty/null
// to "" to avoid noisy cells. Don't unify the two without auditing callers.
export function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}
