import path from 'node:path';
import { AccessError, type DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RecentRootEntry } from '@brainstrike/types';
import { pathsEqual } from './workspace-root-read';

export const RECENT_ROOTS_LIMIT = 20;
export const RECENT_ROOTS_STORAGE_KEY = 'recentRootsList' as const;

const logger = createLogger('WorkspaceRecentRoots');

/**
 * One entry in the main-owned ledger of folders the user has ALREADY granted
 * this app (picker grants and successful restores).
 *
 * It is deliberately separate from `rootsList` (the currently-connected roots):
 * a disconnect removes a root from `rootsList` but must NOT revoke the grant,
 * because the grant is what authorizes the picker-less
 * `WorkspaceRootRegistry.addRootByPath`.
 */
export interface StoredRecentRoot {
  readonly lastGrantedAt: number;
  readonly path: string;
}

/**
 * Pure validation, mirroring `parseStoredRoots`: a corrupt ledger THROWS rather
 * than silently resetting to empty. A silently-empty ledger would report that
 * no folder was ever granted and make `addRootByPath` reject folders the user
 * really did grant — a wrong answer dressed up as a legitimate one.
 */
export function parseStoredRecentRoots(raw: string | null): StoredRecentRoot[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('recentRootsList is not valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error('recentRootsList is not an array.');
  }
  return parsed.map((entry: unknown) => {
    if (!(entry && typeof entry === 'object')) {
      throw new Error('recentRootsList entry is malformed.');
    }
    const candidate = entry as Record<string, unknown>;
    const entryPath = candidate['path'];
    const lastGrantedAt = candidate['lastGrantedAt'];
    if (
      typeof entryPath !== 'string' ||
      entryPath.length === 0 ||
      typeof lastGrantedAt !== 'number' ||
      !Number.isFinite(lastGrantedAt)
    ) {
      throw new Error('recentRootsList entry is malformed.');
    }
    return { lastGrantedAt, path: entryPath };
  });
}

export async function readRecentRoots(
  storage: ElectronStorageAdapter
): Promise<StoredRecentRoot[]> {
  return parseStoredRecentRoots(await storage.getItem(RECENT_ROOTS_STORAGE_KEY));
}

/**
 * Append a grant to the ledger: newest first, deduped by path, capped at
 * RECENT_ROOTS_LIMIT.
 *
 * A ledger append must never fail the grant it is recording. The same broken
 * storage that fails here already degrades `rootsList` persistence to a
 * deliberate session-only mount (see `persistAddedRoot`), and `restoreRoots`
 * must still complete. The failure is LOGGED, never swallowed silently, and it
 * is self-announcing at the point of use: the folder simply does not appear in
 * Recents, and `addRootByPath` rejects it with an actionable message. READS
 * stay fail-loud — `parseStoredRecentRoots` throws on a corrupt ledger, and a
 * failed read here leaves the corrupt value in place rather than overwriting
 * the evidence.
 */
export async function recordRecentRoot(
  storage: ElectronStorageAdapter,
  presentationPath: string
): Promise<void> {
  try {
    const normalized = path.normalize(presentationPath);
    const existing = (await readRecentRoots(storage)).filter(
      (entry) => !pathsEqual(entry.path, normalized)
    );
    const next = [{ lastGrantedAt: Date.now(), path: normalized }, ...existing].slice(
      0,
      RECENT_ROOTS_LIMIT
    );
    await storage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn('Failed to record a recently granted workspace folder', { error });
  }
}

/**
 * Newest-first projection of the ledger for the renderer. Nothing is filtered
 * out: a currently-mounted root is still a recent, and the renderer owns the
 * "already open" presentation decision.
 */
export async function listRecentRootEntries(
  storage: ElectronStorageAdapter
): Promise<readonly RecentRootEntry[]> {
  return (await readRecentRoots(storage)).map((entry) => ({
    displayName: path.basename(entry.path) || entry.path,
    lastGrantedAt: entry.lastGrantedAt,
    path: entry.path,
  }));
}

/**
 * Turn a requested path into a mountable directory handle, or throw.
 *
 * The ledger is the ONLY authorization for the picker-less `addRootByPath`: an
 * unrecorded path is rejected outright rather than quietly granted, so a
 * renderer (or a compromised one) cannot turn an arbitrary string into
 * workspace access. It grants nothing new — every path it accepts was already
 * granted through the OS picker or a successful restore.
 */
export async function resolveGrantedRootHandle(
  storage: ElectronStorageAdapter,
  requestedPath: string
): Promise<DirectoryHandle> {
  const normalized = path.normalize(requestedPath);
  const granted = (await readRecentRoots(storage)).some((entry) =>
    pathsEqual(entry.path, normalized)
  );
  if (!granted) {
    throw new AccessError(
      'Folder was never granted in this app; use Add Folder to grant it.',
      requestedPath,
      'read'
    );
  }
  return {
    kind: 'directory',
    name: path.basename(normalized) || normalized,
    path: normalized,
    platform: 'electron',
  };
}
