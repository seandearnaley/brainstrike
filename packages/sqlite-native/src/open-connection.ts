import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';

const ASAR_SEGMENT = `${sep}app.asar${sep}`;
const UNPACKED_SEGMENT = `${sep}app.asar.unpacked${sep}`;

/**
 * Maps a resolved extension path to the file `dlopen` can actually load.
 *
 * Inside a packaged app, `sqlite-vec` resolves its platform package through
 * `app.asar`, a virtual path that only Electron's patched `fs` understands.
 * SQLite `dlopen()`s the extension itself and bypasses that shim, so the only
 * loadable file is the real one `asarUnpack` wrote to `app.asar.unpacked`.
 * `fs.existsSync` reports true for the asar path too, so it is never trusted
 * as evidence that the load will work.
 *
 * One deterministic mapping, no fallback: a missing unpacked file means the
 * packaging is wrong, so this throws instead of handing back the asar path.
 */
export function unpackedExtensionPath(resolved: string): string {
  if (!resolved.includes(ASAR_SEGMENT)) {
    return resolved;
  }
  const unpacked = resolved.replace(ASAR_SEGMENT, UNPACKED_SEGMENT);
  if (!existsSync(unpacked)) {
    throw new Error(
      `sqlite-vec extension is not asarUnpacked: ${unpacked} does not exist (resolved ${resolved}). Add the sqlite-vec platform package's vec0 library to electron-builder asarUnpack.`
    );
  }
  return unpacked;
}

/** The absolute path of the `vec0` loadable extension for this platform. */
export function sqliteVecExtensionPath(): string {
  return unpackedExtensionPath(getLoadablePath());
}

/**
 * Opens a better-sqlite3 connection and loads the sqlite-vec extension into it.
 * Pragmas, schema and journaling are the caller's decision: this only owns the
 * native load path. A failed extension load closes the connection it opened.
 */
export function openConnection(path: string, options?: Database.Options): Database.Database {
  const db = new Database(path, options);
  try {
    db.loadExtension(sqliteVecExtensionPath());
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
