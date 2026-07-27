/**
 * The one "save this to the user's Downloads folder" path: filename builder +
 * Blob → object URL → anchor → revoke save, shared by the log export, the
 * diagnostics NDJSON export and the assistant debug bundle.
 *
 * The filename half exists because the obvious idiom — dropping
 * `new Date().toISOString()` straight into `anchor.download` — produces
 * `2026-07-27T14:32:05.123Z`, which carries `:` and millis. Windows rejects
 * `:` in filenames and browsers silently mangle the name rather than failing,
 * so the user ends up with a file they did not ask for and no error to explain
 * it. The save half exists so the revoke timing below is stated once instead of
 * once per call site.
 */

/** Everything a filesystem (Windows in particular) rejects, plus separators. */
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;
const MILLIS_SUFFIX = /\.\d+Z$/;

/**
 * Strips everything outside `[a-zA-Z0-9._-]`. Exported so callers that need to
 * measure a segment before handing it over — the debug bundle truncates a run
 * id to 8 characters and wants 8 USABLE ones — sanitize against exactly the
 * charset this module strips against, rather than keeping a second copy of the
 * regex that could drift.
 */
export function sanitizeFilenameSegment(value: string): string {
  return value.replace(UNSAFE_FILENAME_CHARS, '');
}

/**
 * UTC, second-resolution, colons swapped for hyphens:
 * `2026-07-27T14-32-05Z`. Timestamp sits between name and suffix so a
 * Downloads folder sorts chronologically within one export kind.
 */
function formatFilesystemSafeTimestamp(generatedAt: Date): string {
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error('Cannot build a download filename from an invalid Date.');
  }
  return generatedAt.toISOString().replace(MILLIS_SUFFIX, 'Z').replace(/:/g, '-');
}

/**
 * `${name}-${timestamp}[-${suffix}].${extension}`, e.g.
 * `brainstrike-errors-2026-07-27T14-32-05Z-recent2000.ndjson`.
 *
 * `name`, `suffix` and `extension` are each sanitized independently, and
 * emptiness is judged AFTER sanitizing: a suffix made entirely of stripped
 * characters would otherwise leave a dangling `-` in the filename. A name or
 * extension that sanitizes away throws rather than silently producing a
 * nameless or extensionless download.
 */
export function formatTimestampedDownloadFilename({
  extension,
  generatedAt,
  name,
  suffix,
}: {
  readonly extension: string;
  readonly generatedAt: Date;
  readonly name: string;
  readonly suffix?: string | null | undefined;
}): string {
  const safeName = sanitizeFilenameSegment(name);
  if (!safeName) {
    throw new Error(`Download filename has no usable name segment: ${JSON.stringify(name)}`);
  }
  const safeExtension = sanitizeFilenameSegment(extension).replace(/^\.+/, '');
  if (!safeExtension) {
    throw new Error(`Download filename has no usable extension: ${JSON.stringify(extension)}`);
  }
  const safeSuffix = suffix ? sanitizeFilenameSegment(suffix) : '';
  const suffixSegment = safeSuffix ? `-${safeSuffix}` : '';
  return `${safeName}-${formatFilesystemSafeTimestamp(generatedAt)}${suffixSegment}.${safeExtension}`;
}

/**
 * Blob → object URL → anchor click → revoke. Throws (never no-ops silently)
 * outside a DOM; the caller surfaces the message.
 *
 * The revoke is DEFERRED a macrotask on the success path and IMMEDIATE on the
 * throwing path — deliberately not a `finally`. Chromium starts the download
 * during click dispatch, but WebKit can fetch the blob a task later, so a
 * synchronous revoke there silently drops the file. Immediate revoke when the
 * click threw is safe: no download started, and a leaked blob would otherwise
 * live as long as the document — which matters when a user retries a failing
 * export and pins one full payload per attempt.
 *
 * This function owns the object URL's whole lifetime, so no call site has to
 * restate either half of that rule.
 */
export function downloadBlobFile({
  blob,
  filename,
}: {
  readonly blob: Blob;
  readonly filename: string;
}): void {
  if (typeof document === 'undefined') {
    throw new Error('Downloads are unavailable outside a browser document.');
  }
  const url = URL.createObjectURL(blob);
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
