import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** The newest minidumps a listing carries; the folder keeps every one until factory reset. */
const CRASH_DUMP_LIST_LIMIT = 20;

export interface CrashDumpEntry {
  /** The Crashpad folder that holds it: `new` while written, then `pending` or `completed` (`reports` on Windows). */
  readonly folder: string;
  readonly modifiedAt: string;
  readonly name: string;
  readonly sizeBytes: number;
}

export interface CrashDumpListing {
  readonly directory: string;
  /** Newest first, at most `CRASH_DUMP_LIST_LIMIT`. */
  readonly dumps: readonly CrashDumpEntry[];
  readonly totalCount: number;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * The minidumps Crashpad has written under `directory`, the profile's
 * `crashDumps` path. A folder Crashpad has not created yet lists as empty;
 * any other read failure throws, so the debug pack says why it has none.
 */
export async function listCrashDumps(directory: string): Promise<CrashDumpListing> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return { directory, dumps: [], totalCount: 0 };
    }
    throw error;
  }
  const dumps: CrashDumpEntry[] = [];
  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith('.dmp'))) {
      continue;
    }
    const filePath = path.join(entry.parentPath, entry.name);
    try {
      const stats = await stat(filePath);
      dumps.push({
        folder: path.relative(directory, entry.parentPath),
        modifiedAt: stats.mtime.toISOString(),
        name: entry.name,
        sizeBytes: stats.size,
      });
    } catch (error) {
      // Crashpad moves a report from new to pending to completed while it works.
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  dumps.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return { directory, dumps: dumps.slice(0, CRASH_DUMP_LIST_LIMIT), totalCount: dumps.length };
}
