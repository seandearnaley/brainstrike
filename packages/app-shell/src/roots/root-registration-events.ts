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
 */

type Waiter = () => void;

// Grows for the lifetime of the app, one entry per root ever registered —
// the same bounded-growth shape as `warnedUnmappedRoots` in
// `use-roots-reconciliation.ts`. A key already in this set means a LATE
// subscriber (one that starts waiting after the notification already fired)
// must resolve immediately rather than wait for an event that already
// happened.
const registeredKeys = new Set<string>();
const waitersByKey = new Map<string, Set<Waiter>>();

/**
 * Marks every entry in `keys` as registered and wakes any waiter currently
 * subscribed to one of them. Called once per successfully-mapped root — never
 * a second source of truth for the mapping itself, which
 * `use-roots-reconciliation.ts` continues to own.
 */
export function notifyRootRegistered(keys: readonly string[]): void {
  for (const key of keys) {
    registeredKeys.add(key);
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
  readonly timeoutMs: number;
}

/**
 * Resolves once `key` has been (or already was) registered. Rejects on
 * timeout — LOUD, never a silent hang, the same bounded-budget contract the
 * polling loop it replaces enforced. Never rejects for any other reason.
 */
export function awaitRootRegistration(
  key: string,
  { timeoutMs }: AwaitRootRegistrationOptions
): Promise<void> {
  if (registeredKeys.has(key)) {
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
      activeWaiters.delete(wake);
      if (activeWaiters.size === 0) {
        waitersByKey.delete(key);
      }
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for root registration: ${key}`));
    }, timeoutMs);
    activeWaiters.add(wake);
  });
}

/**
 * Test-only: clears every registered key and pending waiter so test files
 * that import this module do not leak state across test cases.
 */
export function resetRootRegistrationEventsForTests(): void {
  registeredKeys.clear();
  waitersByKey.clear();
}
