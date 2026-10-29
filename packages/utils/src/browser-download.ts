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
const UNSAFE_FILENAME_CHARS = /[^a-zA-Z0-9._-]/gu;
const MILLIS_SUFFIX = /\.\d+Z$/u;

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
  return generatedAt.toISOString().replace(MILLIS_SUFFIX, 'Z').replace(/:/gu, '-');
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
  const safeExtension = sanitizeFilenameSegment(extension).replace(/^\.+/u, '');
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
 * How long a clicked ANCHOR-ROUTE download keeps its object URL alive before
 * revoking.
 *
 * `click()` returning only means the anchor dispatched; the download manager
 * resolves the blob URL asynchronously in the browser process (Chromium: over
 * IPC to the blob registry; WebKit: possibly a task later). A revoke that wins
 * that race kills the download AFTER the caller already reported success —
 * observed as the debug-bundle "Saved" with no file on disk (2026-08-03). The
 * deferral used to be one macrotask, which is not a bound the resolution race
 * respects; this is a wall-clock grace period instead. Cost: one export
 * payload pinned per attempt for this long.
 *
 * This is a HEURISTIC, not a proven bound — the renderer never observes the
 * event it is waiting out. What defeats it: a save-as dialog (Chromium's "Ask
 * where to save each file", or a `will-download` handler that prompts) left
 * open past the delay, or a very large payload on a very slow disk. The
 * deterministic fix — a platform save path with a completion signal — is the
 * `window.fileExports` bridge below, which desktop uses instead of this route;
 * the heuristic remains for web, where no such path exists. 60 s rather than
 * FileSaver.js's 40 s: finalization measured ~9 s AFTER the click on an idle
 * dev machine, so the margin is deliberately generous — the extra 20 s of
 * pinned payload is cheap at current export sizes; revisit the cost note
 * above before growing it further.
 */
export const DOWNLOAD_BLOB_REVOKE_DELAY_MS = 60_000;

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
 * is DEFERRED `DOWNLOAD_BLOB_REVOKE_DELAY_MS` on the success path (see that
 * constant for why a shorter deferral silently drops files) and IMMEDIATE on
 * the throwing path — deliberately not a `finally`. Immediate revoke when the
 * click threw is safe: no download started, and a leaked blob would otherwise
 * live as long as the document — which matters when a user retries a failing
 * export and pins one full payload per attempt. This function owns the object
 * URL's whole lifetime, so no call site has to restate either half of that
 * rule.
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
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_BLOB_REVOKE_DELAY_MS);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  // The anchor route cannot know the on-disk name (the browser may uniquify
  // in its own download pipeline), so no `path` is reported.
  return {};
}
