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
 * AFTER that read — satisfies the wait.
 *
 * FACTORY RESET (see `docs/agents/platform-contracts.md` § FACTORY RESET
 * CONTRACT — this module is named there, deliberately un-wired, alongside
 * this reasoning): a reset wipes the `roots` table but NOT `seqByKey` below —
 * there is no resetter registered for this module in
 * `register-factory-reset-session-stores.ts`, and there must not be. This
 * module DOES hold a fact a reset makes wrong to keep as an absolute — "path P
 * has registered N times" becomes false the instant the DB row it counted is
 * gone. What keeps it correct anyway is that its ONLY consumer
 * (`resolveRootIdAfterReconciliation` in `use-workspace-bar.ts`) never reads
 * the counter as an absolute, only as a DELTA: capture-before-read, compare
 * strictly-greater. A stale (pre-reset) generation can structurally never
 * satisfy a wait captured after it, so a survived-reset counter is harmless —
 * pinned by the real reset-pipeline test in
 * `register-factory-reset-session-stores.test.ts`. Wiring a resetter here
 * would make things WORSE, not better: clearing `seqByKey` mid-session (the
 * reset-without-reload path this repo's own contract exists for) would strand
 * any IN-FLIGHT waiter whose `since` sits above the post-reset generation
 * (e.g. `since: 3`, reset rebumps to 1) — `1 > 3` is false forever, so that
 * waiter would run its full bounded timeout and raise the destructive "Folder
 * added, but not attached to this thread" toast on a request that should have
 * succeeded. See `rootRegistrationSeq` below for the one way this delta-only
 * safety argument can be reopened.
 */

type Waiter = () => void;

// Grows for the lifetime of the app, one entry per PATH/adapter-id ever
// registered (not one per registration) — the same bounded-growth shape as
// `warnedUnmappedRoots` in `use-roots-reconciliation.ts`. The counter, not
// membership, is what a waiter compares against.
const seqByKey = new Map<string, number>();
const waitersByKey = new Map<string, Set<Waiter>>();

/**
 * The current registration generation for `key` (0 = never registered).
 *
 * ONLY valid as a BEFORE snapshot to pass through as `awaitRootRegistration`'s
 * `since` — a fresh capture, compared strictly-greater. Never read it as an
 * absolute: `rootRegistrationSeq(key) > 0` reconstructs the exact "was this
 * key EVER registered?" membership predicate BST-1400 removed as a Critical
 * (a stale registration would then read as "still registered" forever), and
 * it is also the one reading a factory reset makes wrong — reset wipes the DB
 * `roots` table this counter describes, not the counter itself.
 */
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
      // Only clean up the set THIS waiter believes it is in. A `notify` can
      // never leave a stale live timer behind (it deletes the map entry and
      // then wakes — clearing the timer of — every member of the set it just
      // unlinked), so this guard is NOT defending against a notify race. It
      // is defending against `resetRootRegistrationEventsForTests` (and, by
      // the same shape, any future reset callback): `waitersByKey.clear()`
      // wakes nobody, so a waiter subscribed before a reset is orphaned with
      // its timer still armed, while a SECOND waiter subscribing after the
      // reset creates a fresh Set under the same key. Without this check, the
      // orphaned waiter's timeout would delete `waitersByKey`'s entry out
      // from under that second, unrelated waiter. Falsified by
      // `root-registration-events.test.ts` — "a stale timer from a WIPED
      // generation must not delete a NEWER waiter set it no longer owns".
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
