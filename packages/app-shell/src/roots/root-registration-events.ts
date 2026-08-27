/**
 * Promise-based "root registered" notification seam (BST-1400 follow-up:
 * await-root-registration seam).
 *
 * `useRootsReconciliation` (this directory's `use-roots-reconciliation.ts`)
 * runs inside `workspace-collection-sync-provider.tsx`, which mounts the
 * `RootIdentityProvider` around the file-explorer/workspace-sync subtree. The
 * assistant composer — and `useWorkspaceBar` inside it — renders as a REACT
 * SIBLING of that subtree, not a descendant (see `root-identity-context.tsx`'s
 * documented context gap), so neither React context nor a prop can reach the
 * reconciliation hook's own `registerRoot`/`resolveDbRootId` callbacks without
 * restructuring the provider tree.
 *
 * This module is the decoupled alternative: a MODULE-SCOPED event bus, the
 * same scope `resolveChangesBridge`/`resolveWorktreesBridge` already use in
 * `use-roots-reconciliation.ts` for cross-subtree singletons. It never
 * restructures the reconciliation state machine — it only NOTIFIES, from the
 * two places that machine already learns a root's durable id (the boot batch
 * in `applyBootReconciliationResult` and the mid-session path in
 * `performRootRegistration`), so a caller elsewhere in the app can AWAIT that
 * fact instead of polling the database for it.
 *
 * Deliberately identity-only: this module does not carry the resolved
 * `roots.id` itself, only the fact that `key` (an adapter rootId or root path)
 * became registered. The caller still reads the row through its own query —
 * this seam replaces the WAIT, never the read, so the existing
 * uniqueness/duplicate-row guard in that read (see
 * `resolveAssistantOperatingRootBinding`) stays authoritative.
 *
 * EPOCH, not membership (BST-1400 review fix). A path can register more than
 * once in a session — remove a root (`fs:removeRoot` leaves the DB row
 * `status = 'disconnected'`) then re-add it. Re-adding mints a FRESH adapter
 * rootId, so `performRootRegistration`'s already-mapped short-circuit does not
 * fire; reconciliation flips the row back to `'live'` and notifies again for
 * the SAME path. A plain "was this key ever registered?" membership set
 * cannot tell that apart from the FIRST registration, so a caller whose first
 * DB read raced the second registration (a real, near-deterministic ordering —
 * `recordAddedAsSecondary` runs in `addRootDirectory().then()`, before React
 * has even re-rendered, let alone before the reconciliation effect's own IPC
 * round trip) would take the "already registered" fast path against a STALE
 * fact and then find the row still missing on its second read. So each key
 * carries a monotonically-increasing GENERATION counter instead of a boolean:
 * a caller captures the generation at (or before) its first failed read and
 * only a STRICTLY LATER generation — one bumped by a registration that landed
 * AFTER that read — satisfies the wait. This is also what keeps this module
 * correct across a factory reset: the reset wipes the `roots` table, not this
 * counter, but a stale (pre-reset) generation number can never satisfy a wait
 * captured after it, so no resetter is needed here (unlike the AGENTS.md
 * "wire new persistent state into factory reset" invariant, this module holds
 * no fact that reset could make wrong to keep).
 */

type Waiter = () => void;

// Grows for the lifetime of the app, one entry per PATH/adapter-id ever
// registered (not one per registration) — the same bounded-growth shape as
// `warnedUnmappedRoots` in `use-roots-reconciliation.ts`. The counter, not
// membership, is what a waiter compares against.
const seqByKey = new Map<string, number>();
const waitersByKey = new Map<string, Set<Waiter>>();

/** The current registration generation for `key` (0 = never registered). */
export function rootRegistrationSeq(key: string): number {
  return seqByKey.get(key) ?? 0;
}

/**
 * Bumps every entry in `keys` to its next generation and wakes any waiter
 * currently subscribed to one of them. Called once per successfully-mapped
 * root — never a second source of truth for the mapping itself, which
 * `use-roots-reconciliation.ts` continues to own.
 */
export function notifyRootRegistered(keys: readonly string[]): void {
  for (const key of keys) {
    seqByKey.set(key, rootRegistrationSeq(key) + 1);
    const waiters = waitersByKey.get(key);
    if (!waiters) {
      continue;
    }
    waitersByKey.delete(key);
    for (const wake of waiters) {
      wake();
    }
  }
}

export interface AwaitRootRegistrationOptions {
  /**
   * The generation observed (via `rootRegistrationSeq`) BEFORE the caller's
   * first failed read — required, not optional, so a caller cannot
   * accidentally fall back to the old membership behavior by omitting it.
   * Only a registration strictly after that observation satisfies the wait.
   */
  readonly since: number;
  readonly timeoutMs: number;
}

/**
 * Resolves once `key`'s generation has advanced past `since` — including
 * immediately, if a registration already did between the caller's read and
 * this call (the late-subscriber case `recordAddedAsSecondary` depends on).
 * Rejects on timeout — LOUD, never a silent hang, the same bounded-budget
 * contract the polling loop it replaces enforced. Never rejects for any other
 * reason.
 */
export function awaitRootRegistration(
  key: string,
  { since, timeoutMs }: AwaitRootRegistrationOptions
): Promise<void> {
  if (rootRegistrationSeq(key) > since) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let waiters = waitersByKey.get(key);
    if (!waiters) {
      waiters = new Set<Waiter>();
      waitersByKey.set(key, waiters);
    }
    const activeWaiters = waiters;
    const wake: Waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // Only clean up the set THIS waiter believes it is in. A notify for an
      // earlier generation already deleted-and-replaced `waitersByKey`'s
      // entry for `key` by the time a later generation's waiters subscribed —
      // that stale timer must not delete the NEWER set it no longer owns.
      if (waitersByKey.get(key) === activeWaiters) {
        activeWaiters.delete(wake);
        if (activeWaiters.size === 0) {
          waitersByKey.delete(key);
        }
      }
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for root registration: ${key}`));
    }, timeoutMs);
    activeWaiters.add(wake);
  });
}

/**
 * Test-only: clears every registration generation and pending waiter so test
 * files that import this module do not leak state across test cases.
 */
export function resetRootRegistrationEventsForTests(): void {
  seqByKey.clear();
  waitersByKey.clear();
}
