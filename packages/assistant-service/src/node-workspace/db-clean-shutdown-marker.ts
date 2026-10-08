import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fsyncDirectory, isNoEntry, writeFileAtomically } from './write-file-atomically.js';

/**
 * The clean-shutdown marker: a sibling of `pgdata/` and `.db-process.lock` in the
 * profile directory (outside pgdata, so an engine-upgrade reconcile never moves it).
 * Its PRESENCE means the last database session closed cleanly; its content is
 * informational. Opening removes it, so a crash anywhere afterwards reads as unclean.
 * Node-only: it runs in the DB host, next to the database it describes.
 */
const CLEAN_SHUTDOWN_MARKER_FILENAME = '.db-clean-shutdown' as const;

function getMarkerPath(appDataDir: string): string {
  return path.join(appDataDir, CLEAN_SHUTDOWN_MARKER_FILENAME);
}

/**
 * Atomically records a clean close: write a temp file, fsync it, rename it over
 * the marker, then fsync the directory. A crash mid-way leaves no marker (a
 * leftover `.tmp` reads as absent), never a partial one.
 */
export function writeCleanShutdownMarker(
  appDataDir: string,
  details: { readonly closedAt: string; readonly pid: number }
): void {
  writeFileAtomically(getMarkerPath(appDataDir), JSON.stringify(details), 'clean-shutdown marker');
}

/** Only a regular file is a marker: a directory (or a link) at the path proves nothing. */
export function hasCleanShutdownMarker(appDataDir: string): boolean {
  try {
    return lstatSync(getMarkerPath(appDataDir)).isFile();
  } catch (error) {
    if (isNoEntry(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Whether the marker was written by process `pid`: proof that host closed its database cleanly.
 * No marker is `false`; an unreadable or malformed one throws, so the caller can say so.
 */
export function cleanShutdownMarkerNamesPid(appDataDir: string, pid: number | undefined): boolean {
  let contents: string;
  try {
    contents = readFileSync(getMarkerPath(appDataDir), 'utf8');
  } catch (error) {
    if (isNoEntry(error)) {
      return false;
    }
    throw error;
  }
  const marker: unknown = JSON.parse(contents);
  const recordedPid = (marker as { pid?: unknown } | null)?.pid;
  if (typeof recordedPid !== 'number') {
    throw new Error('The clean-shutdown marker does not record a pid.');
  }
  return pid !== undefined && recordedPid === pid;
}

/** Removes the marker, durably. An absent marker is fine; any other failure throws. */
export function removeCleanShutdownMarker(appDataDir: string): void {
  try {
    unlinkSync(getMarkerPath(appDataDir));
  } catch (error) {
    if (isNoEntry(error)) {
      return;
    }
    throw error;
  }
  fsyncDirectory(appDataDir);
}
