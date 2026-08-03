/**
 * The one "save this to the user's Downloads folder" path: filename builder +
 * save, shared by the log export, the diagnostics NDJSON export, the assistant
 * debug bundle and the DB Explorer CSV/ZIP exports.
 *
 * The save half has two routes. On desktop, `window.fileExports` (Electron
 * preload bridge) writes the bytes in the MAIN process with `fs` — Chromium's
 * blob-download pipeline is bypassed entirely because a blob download whose
 * URL is revoked mid-flight can wedge as a permanently in-progress download
 * item, and wedged items then jam later downloads for the whole session. On
 * web (bridge absent) it is the classic Blob → object URL → anchor → revoke
 * flow, with the revoke timing stated once here instead of once per call site.
 *
 * The filename half exists because the obvious idiom — dropping
 * `new Date().toISOString()` straight into `anchor.download` — produces
 * `2026-07-27T14:32:05.123Z`, which carries `:` and millis. Windows rejects
 * `:` in filenames and browsers silently mangle the name rather than failing,
 * so the user ends up with a file they did not ask for and no error to explain
 * it.
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

/** Structured result the desktop save bridge resolves; it never rejects across IPC. */
export interface FileExportsSaveOutcome {
  readonly error?: string;
  readonly ok: boolean;
  readonly path?: string;
}

/**
 * Desktop-only save bridge exposed by the Electron preload as
 * `window.fileExports` (see `apps/desktop/src/ipc-file-exports-handlers.ts`).
 * Absent on web; its presence IS the capability check.
 */
export interface FileExportsBridge {
  readonly saveToDownloads: (payload: {
    readonly bytes: Uint8Array;
    readonly filename: string;
  }) => Promise<FileExportsSaveOutcome>;
}

/**
 * `null` means the bridge is genuinely absent (web, or no window at all) and
 * the anchor route applies. A PRESENT bridge with the wrong shape is a broken
 * desktop build and throws — falling back to the anchor route there would
 * silently reintroduce the wedged-download pipeline this bridge exists to
 * avoid.
 */
function resolveFileExportsBridge(): FileExportsBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { fileExports?: Partial<FileExportsBridge> | null })
    .fileExports;
  if (bridge === undefined) {
    return null;
  }
  // `null` counts as PRESENT-but-broken (the preload only ever omits the key,
  // never nulls it), so it takes the deliberate malformed path rather than a
  // bare TypeError on the property read below.
  if (bridge === null || typeof bridge.saveToDownloads !== 'function') {
    throw new Error('window.fileExports bridge is malformed: saveToDownloads is not a function.');
  }
  return bridge as FileExportsBridge;
}

/**
 * Saves a blob as `filename` in the user's Downloads folder. Throws (never
 * no-ops silently) on failure or outside a DOM; the caller surfaces the
 * message.
 *
 * Desktop (`window.fileExports` present): the bytes cross IPC and main writes
 * them with `fs` — no object URL, no Chromium download item. A `{ ok: false }`
 * result becomes a throw here so failures surface at the call site. Main never
 * overwrites — a collision retargets to a ` (n)`-countered name — so the
 * resolved `path` is returned and callers that NAME the file to the user must
 * use it rather than the requested filename.
 *
 * Web (bridge absent): Blob → object URL → anchor click → revoke. The revoke
 * is DEFERRED a macrotask on the success path and IMMEDIATE on the throwing
 * path — deliberately not a `finally`. Chromium starts the download during
 * click dispatch, but WebKit can fetch the blob a task later, so a synchronous
 * revoke there silently drops the file. Immediate revoke when the click threw
 * is safe: no download started, and a leaked blob would otherwise live as long
 * as the document — which matters when a user retries a failing export and
 * pins one full payload per attempt. This function owns the object URL's whole
 * lifetime, so no call site has to restate either half of that rule.
 */
export async function downloadBlobFile({
  blob,
  filename,
}: {
  readonly blob: Blob;
  readonly filename: string;
}): Promise<{ readonly path?: string }> {
  const bridge = resolveFileExportsBridge();
  if (bridge) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await bridge.saveToDownloads({ bytes, filename });
    if (!result.ok) {
      throw new Error(result.error ?? 'Desktop save failed without an error message.');
    }
    return result.path === undefined ? {} : { path: result.path };
  }
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
  // The anchor route cannot know the on-disk name (the browser may uniquify
  // in its own download pipeline), so no `path` is reported.
  return {};
}
