/**
 * Content-based binary detection for the token indexer.
 *
 * Split out of `background-indexer.worker.ts` so it can be tested directly:
 * that module installs `self.addEventListener` handlers at import time, so it
 * cannot be loaded outside a worker environment, which left this heuristic —
 * the one that decides whether a file gets a token count at all — with no
 * coverage while it was the prime suspect in a 149-record error flood.
 *
 * It is a CONTENT check, deliberately distinct from `isBinaryFile` in
 * `@brainstrike/utils/file-utils`, which decides by extension before any bytes
 * are read. Extensions gate dispatch; this gates counting.
 */

/** Bytes below 0x20 that are ordinary in text files and must not count against it. */
const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const FIRST_PRINTABLE = 32;

/**
 * Only the first 8KB is examined, so a file whose sole NUL sits past this
 * window reads as text and is counted normally. That is a deliberate cost
 * ceiling, not an oversight — but it does mean the verdict is size-dependent
 * and can differ between two files with the same defect.
 */
const SAMPLE_SIZE = 8192;

/** Above this share of control characters in the sample, treat the file as binary. */
const NON_PRINTABLE_RATIO_THRESHOLD = 0.1;

export function isBinaryContent(content: string): boolean {
  const sampleSize = Math.min(content.length, SAMPLE_SIZE);
  // Empty content is TEXT: it reads fine and counts as zero tokens. Guarded
  // explicitly because the ratio below would otherwise be 0/0 — the `NaN > x`
  // comparison happens to return false, but only by arithmetic accident, and
  // it would silently flip to `true` if the comparison ever became `>=`.
  if (sampleSize === 0) {
    return false;
  }

  let nonPrintable = 0;
  for (let index = 0; index < sampleSize; index++) {
    const code = content.charCodeAt(index);
    if (code === 0) {
      return true; // Null byte = definitely binary
    }
    if (code < FIRST_PRINTABLE && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN) {
      nonPrintable++;
    }
  }

  return nonPrintable / sampleSize > NON_PRINTABLE_RATIO_THRESHOLD;
}
