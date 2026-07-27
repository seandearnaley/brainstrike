/**
 * Filename + save-to-disk helpers for the failed-message debug bundle.
 *
 * Split out of `copy-debug-bundle-button.tsx` because that module is
 * component-only by contract (react-doctor `only-export-components` / Fast
 * Refresh boundary) — these are pure/DOM helpers with their own unit test.
 */

const FILENAME_PREFIX = 'brainstrike-debug-bundle';
const RUN_ID_CHARS = 8;
/** Everything a filesystem (Windows in particular) rejects, plus separators. */
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;

/**
 * `brainstrike-debug-bundle-2026-07-27T14-32-05Z[-run-1a2b3c4d].md`.
 *
 * UTC, second-resolution, colons swapped for hyphens: an ISO string pasted
 * straight into `anchor.download` (the idiom in `log-viewer.tsx`) carries
 * `:` and `.`-millis, which Windows rejects and browsers silently mangle.
 * Timestamp-first so a Downloads folder sorts chronologically; the short run
 * id disambiguates two failures in the same second and lets a reader match
 * the file back to a ledger row without opening it.
 */
export function formatDebugBundleFilename({
  generatedAt,
  runId,
}: {
  readonly generatedAt: Date;
  readonly runId: string | null;
}): string {
  const timestamp = generatedAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
  const suffix = runId
    ? `-run-${runId.replace(UNSAFE_FILENAME_CHARS, '').slice(0, RUN_ID_CHARS)}`
    : '';
  return `${FILENAME_PREFIX}-${timestamp}${suffix}.md`;
}

/**
 * Blob → object URL → anchor click → revoke, the same download idiom used by
 * `log-viewer.tsx` and `logging-settings-section.tsx`. Throws (never
 * no-ops silently) outside a DOM; the caller surfaces the message inline.
 * The revoke runs on the throwing path too, so a blocked click cannot leak
 * a 200 KB blob for the lifetime of the document.
 */
export function downloadDebugBundleFile({
  contents,
  filename,
}: {
  readonly contents: string;
  readonly filename: string;
}): void {
  if (typeof document === 'undefined') {
    throw new Error('Downloads are unavailable outside a browser document.');
  }
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
