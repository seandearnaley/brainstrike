/**
 * Filename builder shared by every "save this to the user's Downloads folder"
 * path (log export, diagnostics NDJSON export, assistant debug bundle).
 *
 * Exists because the obvious idiom — dropping `new Date().toISOString()`
 * straight into `anchor.download` — produces `2026-07-27T14:32:05.123Z`,
 * which carries `:` and millis. Windows rejects `:` in filenames and browsers
 * silently mangle the name rather than failing, so the user ends up with a
 * file they did not ask for and no error to explain it.
 */

/** Everything a filesystem (Windows in particular) rejects, plus separators. */
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/g;
const MILLIS_SUFFIX = /\.\d+Z$/;

function sanitize(value: string): string {
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
  const safeName = sanitize(name);
  if (!safeName) {
    throw new Error(`Download filename has no usable name segment: ${JSON.stringify(name)}`);
  }
  const safeExtension = sanitize(extension).replace(/^\.+/, '');
  if (!safeExtension) {
    throw new Error(`Download filename has no usable extension: ${JSON.stringify(extension)}`);
  }
  const safeSuffix = suffix ? sanitize(suffix) : '';
  const suffixSegment = safeSuffix ? `-${safeSuffix}` : '';
  return `${safeName}-${formatFilesystemSafeTimestamp(generatedAt)}${suffixSegment}.${safeExtension}`;
}
