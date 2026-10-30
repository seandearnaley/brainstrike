/**
 * Filename for the failed-message debug bundle; `saveDownload` saves it.
 *
 * Split out of `copy-debug-bundle-button.tsx` because that module is
 * component-only by contract (react-refresh `only-export-components` / Fast
 * Refresh boundary) — this is a pure helper with its own unit test.
 */

import {
  formatTimestampedDownloadFilename,
  sanitizeFilenameSegment,
} from '@brainstrike/utils/browser-download';

const FILENAME_PREFIX = 'brainstrike-debug-bundle';
const RUN_ID_CHARS = 8;

/**
 * `brainstrike-debug-bundle-2026-07-27T14-32-05Z[-run-1a2b3c4d].md`.
 *
 * The filesystem-safe timestamp — and the guarantee that an all-stripped run
 * id leaves no dangling `-run-` segment — come from the shared helper. The
 * only bundle-specific part is the short run id, which disambiguates two
 * failures in the same second and lets a reader match the file back to a
 * ledger row without opening it. It is sanitized with the shared
 * `sanitizeFilenameSegment` BEFORE truncating, so the 8 characters kept are 8
 * USABLE ones rather than 8 pre-strip ones.
 */
export function formatDebugBundleFilename({
  generatedAt,
  runId,
}: {
  readonly generatedAt: Date;
  readonly runId: string | null;
}): string {
  const shortRunId = sanitizeFilenameSegment(runId ?? '').slice(0, RUN_ID_CHARS);
  return formatTimestampedDownloadFilename({
    extension: 'md',
    generatedAt,
    name: FILENAME_PREFIX,
    suffix: shortRunId ? `run-${shortRunId}` : null,
  });
}
