/**
 * Main-process save path for renderer file exports (debug bundle, log JSON,
 * diagnostics NDJSON, DB Explorer CSVs). Writes the bytes straight into the
 * OS Downloads folder with `fs` instead of routing a blob URL through
 * Chromium's download pipeline, which can wedge a download item permanently
 * when the object URL is revoked mid-flight (and jammed items then block
 * later downloads for the whole session).
 *
 * The filename is renderer-supplied and therefore untrusted: it must match
 * the same `[a-zA-Z0-9._-]` charset `@brainstrike/utils`'s filename builder
 * emits, which excludes every path separator, so the write cannot escape the
 * Downloads directory. Writes are exclusive-create (`O_EXCL`) with a
 * Chromium-style ` (n)` counter on collision — this path never overwrites an
 * existing file. `secure-file-write.ts` is deliberately not reused here: it
 * is workspace-root/overwrite oriented (`O_TRUNC`), while this path needs
 * create-only semantics against a validated leaf filename.
 */

import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export interface FileExportsSaveResult {
  error?: string;
  ok: boolean;
  path?: string;
}

interface FileExportsIpcDependencies {
  getDownloadsPath: () => string;
}

const SAFE_EXPORT_FILENAME = /^[a-zA-Z0-9._-]+$/u;
const DOTS_ONLY = /^\.+$/u;
/**
 * Common filesystem NAME_MAX (255) minus room for the widest collision
 * counter this module can append (` (99)`), so a colliding near-limit name
 * still fails with the clear message below instead of a raw ENAMETOOLONG
 * from inside the write loop.
 */
const MAX_FILENAME_LENGTH = 255 - ' (99)'.length;
/**
 * Collisions require an identical second-resolution timestamped name, so more
 * than a handful of attempts means something is pathological — give up with a
 * visible error instead of scanning forever.
 */
const MAX_COLLISION_ATTEMPTS = 100;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateFilename(rawFilename: unknown): { error: string } | { filename: string } {
  if (typeof rawFilename !== 'string' || rawFilename.length === 0) {
    return { error: 'file-exports saveToDownloads requires a non-empty filename string' };
  }
  if (rawFilename.length > MAX_FILENAME_LENGTH) {
    return { error: `file-exports filename exceeds ${MAX_FILENAME_LENGTH} characters` };
  }
  if (!SAFE_EXPORT_FILENAME.test(rawFilename) || DOTS_ONLY.test(rawFilename)) {
    return { error: `file-exports filename contains unsupported characters: ${rawFilename}` };
  }
  return { filename: rawFilename };
}

/** `report.csv` → `report (2).csv`; extensionless/dotfile names get a plain ` (2)` tail. */
function withCollisionCounter(filename: string, attempt: number): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) {
    return `${filename} (${attempt})`;
  }
  return `${filename.slice(0, dotIndex)} (${attempt})${filename.slice(dotIndex)}`;
}

/**
 * Exclusive-create write with a collision counter. O_EXCL makes create-and-
 * claim atomic (no lstat→open TOCTOU window), and O_NOFOLLOW backstops a
 * symlink racing into the leaf slot. Throws on any failure other than EEXIST.
 */
async function writeWithCollisionCounter(
  downloadsDir: string,
  filename: string,
  bytes: Uint8Array
): Promise<FileExportsSaveResult> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? filename : withCollisionCounter(filename, attempt - 1);
    const targetPath = path.join(downloadsDir, candidate);
    let fileHandle: fsPromises.FileHandle;
    try {
      fileHandle = await fsPromises.open(targetPath, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
    try {
      await fileHandle.writeFile(bytes);
    } catch (error) {
      // The O_EXCL open above claimed this name, so the zero/partial file is
      // ours to remove — leaving it would strand a corrupt export in Downloads
      // AND make a retry land on a counter-suffixed name because the original
      // is still occupied. Cleanup is best-effort: the write error (ENOSPC,
      // I/O) is the one worth surfacing, not a secondary close/unlink failure.
      await fileHandle.close().catch(() => undefined);
      await fsPromises.unlink(targetPath).catch(() => undefined);
      throw error;
    }
    await fileHandle.close();
    return { ok: true, path: targetPath };
  }
  return {
    error: `Could not find a free filename for ${filename} after ${MAX_COLLISION_ATTEMPTS} attempts`,
    ok: false,
  };
}

export function createFileExportsIpcHandlers({ getDownloadsPath }: FileExportsIpcDependencies) {
  return {
    saveToDownloads: async (rawPayload: unknown): Promise<FileExportsSaveResult> => {
      if (typeof rawPayload !== 'object' || rawPayload === null) {
        return { error: 'file-exports saveToDownloads requires an object payload', ok: false };
      }
      const { bytes, filename: rawFilename } = rawPayload as {
        bytes?: unknown;
        filename?: unknown;
      };
      const validated = validateFilename(rawFilename);
      if ('error' in validated) {
        return { error: validated.error, ok: false };
      }
      // `ArrayBuffer.isView` instead of `instanceof Uint8Array`: the view may
      // come from another realm (Electron IPC delivery), where instanceof is
      // false for a perfectly good byte view.
      if (!ArrayBuffer.isView(bytes)) {
        return { error: 'file-exports saveToDownloads requires Uint8Array bytes', ok: false };
      }
      const byteView =
        bytes instanceof Uint8Array
          ? bytes
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      try {
        return await writeWithCollisionCounter(getDownloadsPath(), validated.filename, byteView);
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}
