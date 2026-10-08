import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('WriteFileAtomically');

/** An `ENOENT` failure: the file (or directory) is simply not there. */
export function isNoEntry(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

// A rename or unlink is durable only once the directory entry itself is flushed.
// Windows cannot open a directory handle from Node, so there the rename is the
// atomic step and the directory flush is skipped.
export function fsyncDirectory(directory: string): void {
  if (process.platform === 'win32') {
    return;
  }
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Best effort: a leftover temp file is not the file, so a failed cleanup costs nothing but tidiness.
function removeTemporaryFile(temporaryPath: string, label: string): void {
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!isNoEntry(error)) {
      logger.warn(`Could not remove the temporary ${label}`, { error, temporaryPath });
    }
  }
}

/**
 * Atomically writes a small file: write a temp file next to it, fsync it, rename it over the
 * target, then fsync the directory. A crash mid-way leaves the previous file (or none), never a
 * partial one; a leftover `.tmp` is not the file. `label` names the file in the warn log when a
 * failed write cannot remove its temp file.
 */
export function writeFileAtomically(filePath: string, contents: string, label: string): void {
  const temporaryPath = `${filePath}.tmp`;
  try {
    const descriptor = openSync(temporaryPath, 'w');
    try {
      writeSync(descriptor, contents);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    // Whichever step failed (open, write, flush or rename), no temp file is left behind.
    removeTemporaryFile(temporaryPath, label);
    throw error;
  }
  fsyncDirectory(path.dirname(filePath));
}
