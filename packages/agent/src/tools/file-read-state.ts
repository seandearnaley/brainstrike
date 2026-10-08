/**
 * Read-before-write staleness tracker (report R8; the compare layer of core
 * 1.51's workspace `requireReadBeforeWrite` contract).
 *
 * Records the last mtime the assistant OBSERVED for a file — via a
 * content-bearing read (readWorkspaceFile, string-replace's checked re-read)
 * or its own successful write — keyed by scope (threadId) + canonical absolute
 * path. The desktop edit tools stat the target inside the per-file write lock
 * and REFUSE with an actionable error when disk no longer matches the recorded
 * observation: the classic lost-update guard (agent read at T0, user edited at
 * T1, agent must not overwrite at T2). Files this scope never observed are not
 * guarded (compare-only, deliberately NOT core's stricter read-required layer),
 * and brand-new files are exempt by construction — there is nothing recorded
 * to compare against.
 *
 * Purely in-memory (per main-process lifetime, like the sibling
 * file-write-lock map) — this is ephemeral run state, not persistence, so it
 * is NOT a factory-reset surface. Unlike the lock map it cannot self-clean
 * when work drains, so it is bounded by insertion-refreshing LRU eviction.
 */

export const FILE_READ_STATE_MAX_ENTRIES = 4096;

/** scope|canonicalPath -> last observed mtimeMs. Map iteration order is
 * insertion order; records re-insert on write, making eviction LRU-on-write. */
const knownMtimes = new Map<string, number>();

function toKey(scope: string, canonicalPath: string): string {
  return `${scope}|${canonicalPath}`;
}

/** Record the mtime observed for `canonicalPath` by `scope` (read or own write). */
export function recordKnownFileMtime(scope: string, canonicalPath: string, mtimeMs: number): void {
  const key = toKey(scope, canonicalPath);
  // Delete-then-set refreshes insertion order so hot files are never evicted
  // ahead of stale ones.
  knownMtimes.delete(key);
  knownMtimes.set(key, mtimeMs);
  if (knownMtimes.size > FILE_READ_STATE_MAX_ENTRIES) {
    const oldest = knownMtimes.keys().next().value;
    if (oldest !== undefined) {
      knownMtimes.delete(oldest);
    }
  }
}

/** The last mtime `scope` observed for `canonicalPath`, or undefined if never observed. */
export function getKnownFileMtime(scope: string, canonicalPath: string): number | undefined {
  return knownMtimes.get(toKey(scope, canonicalPath));
}

/** Drop one observation (file deleted, or rename source moved away). */
export function forgetKnownFile(scope: string, canonicalPath: string): void {
  knownMtimes.delete(toKey(scope, canonicalPath));
}

/** Drop every observation one scope (thread) made; its thread was deleted. */
export function forgetFileReadScope(scope: string): void {
  const prefix = toKey(scope, '');
  for (const key of [...knownMtimes.keys()]) {
    if (key.startsWith(prefix)) {
      knownMtimes.delete(key);
    }
  }
}

/** Clear all observations (test isolation). */
export function resetFileReadState(): void {
  knownMtimes.clear();
}
