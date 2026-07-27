/**
 * Filename + save-to-disk helpers for the failed-message debug bundle.
 *
 * Split out of `copy-debug-bundle-button.tsx` because that module is
 * component-only by contract (react-doctor `only-export-components` / Fast
 * Refresh boundary) — these are pure/DOM helpers with their own unit test.
 */

import { formatTimestampedDownloadFilename } from '@brainstrike/utils';

const FILENAME_PREFIX = 'brainstrike-debug-bundle';
const RUN_ID_CHARS = 8;
/** Everything a filesystem (Windows in particular) rejects, plus separators. */
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;

/**
 * `brainstrike-debug-bundle-2026-07-27T14-32-05Z[-run-1a2b3c4d].md`.
 *
 * The filesystem-safe timestamp comes from the shared
 * `formatTimestampedDownloadFilename` (also used by the log and diagnostics
 * exports); the only bundle-specific part is the short run id, which
 * disambiguates two failures in the same second and lets a reader match the
 * file back to a ledger row without opening it. Truncation happens AFTER
 * sanitizing so a run id of stripped characters cannot leave a dangling
 * `-run-` segment.
 */
export function formatDebugBundleFilename({
  generatedAt,
  runId,
}: {
  readonly generatedAt: Date;
  readonly runId: string | null;
}): string {
  const shortRunId = runId?.replace(UNSAFE_FILENAME_CHARS, '').slice(0, RUN_ID_CHARS) ?? '';
  return formatTimestampedDownloadFilename({
    extension: 'md',
    generatedAt,
    name: FILENAME_PREFIX,
    suffix: shortRunId ? `run-${shortRunId}` : null,
  });
}

/**
 * Blob → object URL → anchor click → revoke, the same download idiom used by
 * `log-viewer.tsx` and `logging-settings-section.tsx`. Throws (never
 * no-ops silently) outside a DOM; the caller surfaces the message inline.
 *
 * The revoke is deferred a macrotask on the SUCCESS path and immediate on the
 * throwing path — deliberately not a `finally`. Chromium starts the download
 * during click dispatch, but WebKit can fetch the blob a task later, so a
 * synchronous revoke there silently drops the file (a silent degradation on
 * the web target). Immediate revoke when the click threw is safe: no download
 * started, and a leaked 200 KB blob would otherwise live as long as the
 * document.
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
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
