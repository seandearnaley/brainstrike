import path from 'node:path';
import { AccessError, type DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { RecentRootEntry } from '@brainstrike/types';
import { pathsEqual } from './workspace-root-paths';

/**
 * Storage hygiene, not authorization intent: the cap bounds how much of this
 * key we keep, and is deliberately far above the number of roots a user
 * realistically keeps connected so mounting many folders cannot evict the
 * disconnected grants the picker-less path depends on.
 */
export const RECENT_ROOTS_LIMIT = 50;
export const RECENT_ROOTS_STORAGE_KEY = 'recentRootsList' as const;
export const CORRUPT_RECENT_ROOTS_STORAGE_KEY = 'recentRootsList.corrupt' as const;

const logger = createLogger('WorkspaceRecentRoots');

/**
 * One entry in the main-owned ledger of folders the user has ALREADY granted
 * this app (picker grants and successful restores).
 *
 * It is deliberately separate from `rootsList` (the currently-connected roots):
 * a disconnect removes a root from `rootsList` but must NOT revoke the grant,
 * because the grant is what lets `WorkspaceRootRegistry.addRootByPath` re-mount
 * a folder without a picker.
 *
 * Trust class: the SAME as `rootsList` + `fs:restoreRoots`. The renderer can
 * already write main storage through the `storage:*` bridge, so this ledger
 * records prior grants and keeps the picker-less path pointed at previously
 * granted folders — it is NOT a hardening boundary against a compromised
 * renderer. Narrowing the `storage:*` bridge with a key allowlist would raise
 * that floor for `rootsList` and this key alike, and is tracked separately.
 */
export interface StoredRecentRoot {
  readonly lastGrantedAt: number;
  readonly path: string;
}

/**
 * Canonical ledger key for a folder path: `path.normalize` plus a stripped
 * trailing separator, so `/ws/alpha/` and `/ws/alpha` occupy one slot instead
 * of two. The filesystem root itself (`/`, `C:\`) legitimately ends in a
 * separator and is left alone.
 */
function normalizeRecentRootPath(candidate: string): string {
  const normalized = path.normalize(candidate);
  if (normalized === path.parse(normalized).root) {
    return normalized;
  }
  return normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized;
}

/**
 * Ledger-key equality. Entries written before trailing-separator stripping
 * existed are normalized on read, so an older ledger keeps matching.
 */
function recentPathsEqual(left: string, right: string): boolean {
  return pathsEqual(normalizeRecentRootPath(left), normalizeRecentRootPath(right));
}

/**
 * Pure validation, mirroring `parseStoredRoots`: it throws on a corrupt ledger
 * rather than coercing it to empty, and never performs I/O. Callers go through
 * `readRecentRootsOrQuarantine`, which tells a corrupt value apart from an I/O
 * failure by reading the raw bytes exactly once itself.
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

/**
 * The ONLY ledger reader, mirroring `readStoredRootsOrQuarantine`: a corrupt
 * value must not permanently brick Recents and the picker-less path, but it is
 * never coerced away in silence — the raw bytes are preserved under
 * `recentRootsList.corrupt` for diagnosis, the failure is logged at ERROR
 * level (loudly, once), the key is reset, and the ledger self-heals from the
 * next grant onward. Until it does, `addRootByPath` rejects with the normal
 * "never granted" remedy, which points the user straight at Add Folder.
 *
 * The raw value is read exactly once. An I/O failure from that single read
 * propagates uncaught (fail loud) rather than being mistaken for corruption;
 * only a validation failure from `parseStoredRecentRoots` — thrown on that
 * same already-read `raw` — triggers quarantine, so the bytes quarantined are
 * provably the exact bytes that failed to parse.
 */
export async function readRecentRootsOrQuarantine(
  storage: ElectronStorageAdapter
): Promise<StoredRecentRoot[]> {
  const raw = await storage.getItem(RECENT_ROOTS_STORAGE_KEY);
  try {
    return parseStoredRecentRoots(raw);
  } catch (error) {
    if (raw !== null) {
      await storage.setItem(CORRUPT_RECENT_ROOTS_STORAGE_KEY, raw);
      await storage.removeItem(RECENT_ROOTS_STORAGE_KEY);
    }
    logger.error('Quarantined a corrupt recently-granted workspace folder ledger', {
      error,
      quarantineKey: CORRUPT_RECENT_ROOTS_STORAGE_KEY,
    });
    return [];
  }
}

/**
 * Append a grant to the ledger: newest first, deduped by path, capped at
 * RECENT_ROOTS_LIMIT.
 *
 * Only the WRITE (`storage.setItem`) may fail without failing the grant it is
 * recording. The same broken storage that fails here already degrades
 * `rootsList` persistence to a deliberate session-only mount (see
 * `persistAddedRoot`), and `restoreRoots` must still complete. That write
 * failure is LOGGED, never swallowed silently, and it is self-announcing at
 * the point of use: the folder simply does not appear in Recents, and
 * `addRootByPath` rejects it with an actionable message.
 *
 * `lastGrantedAt` defaults to now; restore paths pass the stored `addedAt` so
 * a relaunch does not rewrite grant history with launch timestamps.
 */
export async function recordRecentRoot(
  storage: ElectronStorageAdapter,
  presentationPath: string,
  lastGrantedAt: number = Date.now()
): Promise<void> {
  const normalized = normalizeRecentRootPath(presentationPath);
  const existing = (await readRecentRootsOrQuarantine(storage)).filter(
    (entry) => !recentPathsEqual(entry.path, normalized)
  );
  const next = [{ lastGrantedAt, path: normalized }, ...existing].slice(0, RECENT_ROOTS_LIMIT);
  try {
    await storage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn('Failed to record a recently granted workspace folder', { error });
  }
}

/**
 * `recordRecentRoot`, but only when `presentationPath` isn't already in the
 * ledger (see `restoreRoots`). Keeps a re-restore of an already-granted path
 * from bumping its `lastGrantedAt` / applying slot pressure on every launch.
 */
export async function recordRecentRootIfNew(
  storage: ElectronStorageAdapter,
  presentationPath: string,
  lastGrantedAt: number
): Promise<void> {
  const normalized = normalizeRecentRootPath(presentationPath);
  const alreadyRecorded = (await readRecentRootsOrQuarantine(storage)).some((recent) =>
    recentPathsEqual(recent.path, normalized)
  );
  if (alreadyRecorded) {
    return;
  }
  await recordRecentRoot(storage, presentationPath, lastGrantedAt);
}

/**
 * Newest-first projection of the ledger for the renderer. Nothing is filtered
 * out: a currently-mounted root is still a recent, and the renderer owns the
 * "already open" presentation decision.
 */
export async function listRecentRootEntries(
  storage: ElectronStorageAdapter
): Promise<readonly RecentRootEntry[]> {
  return (await readRecentRootsOrQuarantine(storage)).map((entry) => ({
    displayName: path.basename(entry.path) || entry.path,
    lastGrantedAt: entry.lastGrantedAt,
    path: entry.path,
  }));
}

/**
 * Three-state result of the managed-worktree authorizer. Only 'authorized'
 * grants; 'managed-but-unauthorized' selects the worktree-specific error COPY
 * for candidates under the managed directory (it never authorizes), and
 * 'unmanaged' keeps the ordinary never-granted message.
 */
export type ManagedWorktreeAuthorization = 'authorized' | 'managed-but-unauthorized' | 'unmanaged';

type WorkspaceConnectBridgeModule =
  typeof import('@brainstrike/app-shell/workspace-connect/workspace-connect-bridge');

const WORKSPACE_CONNECT_BRIDGE_MODULE =
  '@brainstrike/app-shell/workspace-connect/workspace-connect-bridge' as const;

/**
 * Electron main is bundled as CJS while app-shell exposes this dependency-light
 * subpath through its ESM `import` condition. A native dynamic import selects
 * that real export condition; a resolution failure propagates rather than
 * falling back to a duplicated refusal string.
 */
async function loadWorkspaceConnectBridgeModule(): Promise<WorkspaceConnectBridgeModule> {
  return import(WORKSPACE_CONNECT_BRIDGE_MODULE);
}

/**
 * Authorizes a path the app itself created under its managed worktree
 * directory. Injected rather than imported so this leaf module keeps its
 * zero-dependency shape and the DB-backed ledger stays in `WorktreeService`.
 */
export type ManagedWorktreeAuthorizer = (
  candidatePath: string
) => Promise<ManagedWorktreeAuthorization>;

export interface GrantedRootHandle {
  readonly grantSource: 'managed-worktree' | 'recents';
  readonly handle: DirectoryHandle;
}

/**
 * The TWO gates on the picker-less `addRootByPath`, in order:
 *
 * 1. the recent-roots ledger — every path in it was already granted through
 *    the OS picker or a successful restore (BST-1395);
 * 2. the managed-worktree authorizer (BST-1390, spec §6.2) — the app CREATED
 *    the path, under its own managed directory, and its ledger row proves it.
 *    This is the second and last sanctioned picker-less mount; it is
 *    deliberately NOT a general "add root by path" door, and a managed worktree
 *    is NOT recorded into the recents ledger at grant time (that list is the
 *    user's folders, not the app's scratch directories). CLOSED (BST-1390
 *    Task 10): the mount remains persisted in `rootsList`, but `restoreRoots`
 *    batch-reads each persisted root's DB kind and skips recents recording for
 *    `kind='worktree'`; an unavailable kind query is warned and preserves the
 *    prior fail-open recents behavior without blocking root restoration.
 *
 * The ledger is checked FIRST so a broken authorizer can never take the
 * recents path down with it. Neither gate is a hardening boundary against a
 * compromised renderer — both are correctness gates at the same trust level as
 * `rootsList`; see the `StoredRecentRoot` doc comment.
 */
export async function resolveGrantedRootHandle(
  storage: ElectronStorageAdapter,
  requestedPath: string,
  isManagedWorktreePath?: ManagedWorktreeAuthorizer
): Promise<GrantedRootHandle> {
  const normalized = normalizeRecentRootPath(requestedPath);
  const granted = (await readRecentRootsOrQuarantine(storage)).some((entry) =>
    recentPathsEqual(entry.path, normalized)
  );
  const handle: DirectoryHandle = {
    kind: 'directory',
    name: path.basename(normalized) || normalized,
    path: normalized,
    platform: 'electron',
  };
  if (granted) {
    return { grantSource: 'recents', handle };
  }
  const {
    WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE,
    WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE: neverGrantedMessage,
  } = await loadWorkspaceConnectBridgeModule();
  if (!isManagedWorktreePath) {
    throw new AccessError(neverGrantedMessage, requestedPath, 'read');
  }

  let authorization: ManagedWorktreeAuthorization;
  try {
    authorization = await isManagedWorktreePath(normalized);
  } catch (error) {
    // A broken authorizer must not become an implicit grant, and must not be
    // silent either.
    logger.error('managed-worktree authorization check threw', { error, path: normalized });
    throw new AccessError(neverGrantedMessage, requestedPath, 'read');
  }
  if (authorization === 'authorized') {
    return { grantSource: 'managed-worktree', handle };
  }
  throw new AccessError(
    authorization === 'managed-but-unauthorized'
      ? WORKSPACE_ROOT_MANAGED_BUT_UNAUTHORIZED_MESSAGE
      : neverGrantedMessage,
    requestedPath,
    'read'
  );
}
