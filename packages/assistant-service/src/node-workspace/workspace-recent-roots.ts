import path from 'node:path';
import { AccessError, type DirectoryHandle } from '@brainstrike/file-system';
import { createLogger } from '@brainstrike/logging';
import type { RecentRootEntry } from '@brainstrike/types';
import { pathsEqual } from './workspace-root-paths.js';
import type { WorkspaceRootStorage } from './workspace-root-types.js';

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
  storage: WorkspaceRootStorage
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
 * Pure ledger transform: applies one grant on top of an already-loaded
 * snapshot — dedup by path (the new grant wins), newest-first, capped at
 * RECENT_ROOTS_LIMIT. Extracted (BST-1400 item 4) so a caller applying MANY
 * grants in one mutation (`recordRecentRootsIfNew`) can fold them all
 * against a single read instead of reading the ledger once per grant.
 */
function withRecentRootGranted(
  existing: readonly StoredRecentRoot[],
  presentationPath: string,
  lastGrantedAt: number
): StoredRecentRoot[] {
  const normalized = normalizeRecentRootPath(presentationPath);
  const deduped = existing.filter((entry) => !recentPathsEqual(entry.path, normalized));
  return [{ lastGrantedAt, path: normalized }, ...deduped].slice(0, RECENT_ROOTS_LIMIT);
}

/**
 * Append a grant to the ledger: newest first, deduped by path, capped at
 * RECENT_ROOTS_LIMIT.
 *
 * `existingEntries`, when supplied, is used INSTEAD OF reading the ledger
 * here (BST-1400 item 4): `WorkspaceRootRegistry.addRoot` reads the ledger
 * up front, before mounting/persisting, so a broken ledger fails the whole
 * call loud BEFORE any state changes rather than after — then hands the
 * snapshot it already has here. Re-reading in that case would either
 * duplicate the I/O or, worse, let a second read fail AFTER the mutation
 * already succeeded, defeating the hoist. Omitted, this reads the ledger
 * itself — the ordinary single-grant case.
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
  storage: WorkspaceRootStorage,
  presentationPath: string,
  lastGrantedAt: number = Date.now(),
  existingEntries?: readonly StoredRecentRoot[]
): Promise<void> {
  const existing = existingEntries ?? (await readRecentRootsOrQuarantine(storage));
  const next = withRecentRootGranted(existing, presentationPath, lastGrantedAt);
  try {
    await storage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    logger.warn('Failed to record a recently granted workspace folder', { error });
  }
}

/**
 * Batch form of `recordRecentRoot { presentationPath isn't already recorded
 * }`, used by `restoreRoots` (BST-1400 item 4): ONE ledger read for the
 * whole restored set instead of up to two reads PER candidate, and at most
 * ONE write instead of one per newly-recorded candidate.
 *
 * `candidates` are applied in order — a path already in the ledger is
 * skipped, preserving its `lastGrantedAt` (a relaunch must not rewrite grant
 * history with launch timestamps); a new path is folded in with
 * `withRecentRootGranted`, the same prepend-and-cap transform a sequence of
 * individual grants would apply, so a batch of N new candidates lands in
 * exactly the order N sequential single-grant calls would have produced.
 */
export async function recordRecentRootsIfNew(
  storage: WorkspaceRootStorage,
  candidates: readonly { readonly lastGrantedAt: number; readonly path: string }[]
): Promise<void> {
  if (candidates.length === 0) {
    return;
  }
  let entries = await readRecentRootsOrQuarantine(storage);
  let changed = false;
  for (const candidate of candidates) {
    const normalized = normalizeRecentRootPath(candidate.path);
    if (entries.some((entry) => recentPathsEqual(entry.path, normalized))) {
      continue;
    }
    entries = withRecentRootGranted(entries, candidate.path, candidate.lastGrantedAt);
    changed = true;
  }
  if (!changed) {
    return;
  }
  try {
    await storage.setItem(RECENT_ROOTS_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    logger.warn('Failed to record recently granted workspace folders during restore', { error });
  }
}

/**
 * Newest-first projection of the ledger for the renderer. Nothing is filtered
 * out: a currently-mounted root is still a recent, and the renderer owns the
 * "already open" presentation decision.
 */
export async function listRecentRootEntries(
  storage: WorkspaceRootStorage
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

/**
 * These two messages are the CANONICAL source `use-connect-folder.tsx`'s
 * refusal-remedy matcher checks against (`WORKSPACE_ROOT_NEVER_GRANTED_MESSAGE(S)`
 * in `@brainstrike/app-shell/workspace-connect/workspace-connect-bridge`).
 * Deliberately NOT imported here: Electron main is bundled as CJS while that
 * app-shell subpath only publishes an ESM `"import"` condition (no `"require"`),
 * and while a native dynamic `import()` of it DOES resolve at runtime (Node's
 * default "detect module syntax" fallback reparses the typeless file as ESM —
 * verified empirically: built the desktop main bundle for real and drove the
 * refusal path through the actual compiled `dist/main.js` output via the
 * pinned Electron 43 binary's own bundled Node runtime), it's a fragile,
 * warning-emitting mechanism for a pure string constant, and the wrong
 * dependency direction (main should not runtime-depend on a renderer-facing
 * UI package). Drift between this file and the canonical export is instead
 * caught at TEST TIME — see `workspace-root-registry-recent-roots.test.ts`'s
 * canonical-message assertions, which import the app-shell constants through
 * Vitest's own resolver (unaffected by the Node CJS/ESM package-boundary
 * problem) and assert this file's actual throw sites still equal them
 * exactly.
 */
const NEVER_GRANTED_MESSAGE = 'Folder was never granted in this app; use Add Folder to grant it.';
const MANAGED_BUT_UNAUTHORIZED_MESSAGE =
  'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.';

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
 * 2. the managed-worktree authorizer (BST-1390, spec §6.2; widened in the
 *    BST-1392 follow-up) — a live `brainstrike_worktrees` ledger row that the
 *    app can REACH per adoption's `assertReachable` rule: under the managed
 *    directory, or inside a granted workspace root
 *    (`isAuthorizedWorktreeMountPath`, worktree-adopt.ts). An outside-roots
 *    row stays refused. This is the second and last sanctioned picker-less
 *    mount; it is deliberately NOT a general "add root by path" door, and a
 *    managed worktree is NOT recorded into the recents ledger at grant time
 *    (that list is the user's folders, not the app's scratch directories). CLOSED (BST-1390
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
  storage: WorkspaceRootStorage,
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
  if (!isManagedWorktreePath) {
    throw new AccessError(NEVER_GRANTED_MESSAGE, requestedPath, 'read');
  }

  let authorization: ManagedWorktreeAuthorization;
  try {
    authorization = await isManagedWorktreePath(normalized);
  } catch (error) {
    // A broken authorizer must not become an implicit grant, and must not be
    // silent either.
    logger.error('managed-worktree authorization check threw', { error, path: normalized });
    throw new AccessError(NEVER_GRANTED_MESSAGE, requestedPath, 'read');
  }
  if (authorization === 'authorized') {
    return { grantSource: 'managed-worktree', handle };
  }
  throw new AccessError(
    authorization === 'managed-but-unauthorized'
      ? MANAGED_BUT_UNAUTHORIZED_MESSAGE
      : NEVER_GRANTED_MESSAGE,
    requestedPath,
    'read'
  );
}
