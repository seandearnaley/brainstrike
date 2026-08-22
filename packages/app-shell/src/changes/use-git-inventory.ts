/**
 * `useGitInventory` (BST-1114 T0): load the repository/worktree topology over
 * the desktop `window.changes` bridge.
 *
 * The Changes surface needs this for two things `ChangesetView` cannot answer:
 * which git scopes are offerable (per repo × worktree) in the source picker,
 * and how to group the changed-files tree (root → repo → worktree). It also
 * carries each worktree's `trust`/`trustReason`, which the UI must render for
 * unvalidated worktrees rather than quietly presenting them as ordinary.
 *
 * Discipline copied from `use-changeset.ts`:
 * - the bridge is resolved ONCE per hook instance (`useMemo` with an empty
 *   dependency array), never per render — `isChangesBridgeAvailable()`
 *   re-resolves and re-logs on every call;
 * - loads are generation-guarded: the counter increments BEFORE the await, is
 *   captured, and every `setState` (including error branches) checks it, so a
 *   slow in-flight load can never overwrite a newer one's result.
 *
 * `inventory` stays `null` until a load succeeds. `null` is "not yet
 * resolved" — NOT the same fact as a resolved inventory with zero
 * repositories, which is an honest "no git repositories in your workspace
 * roots". Consumers must distinguish the two.
 *
 * Loading is eager by default. `deferInitialLoad` (BST-1116 W6 review finding
 * 4) is an OPT-IN escape for callers behind a user gesture — see
 * {@link UseGitInventoryOptions.deferInitialLoad}. A whole repo/worktree scan
 * across every workspace root is not free, and the git panel header used to
 * pay for it on every panel mount whether or not its worktree dropdown was
 * ever opened.
 *
 * `inventory.errors` is a first-class part of the payload: per-repository
 * failures are reported there rather than dropping the repository, so a
 * consumer that ignores `errors` is hiding real breakage.
 */
import { createLogger } from '@brainstrike/logging';
import type { GitInventory } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveChangesBridge } from './changes-bridge';
import { useChangesLiveRefreshStore } from './changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from './use-changes-live-refresh';

const logger = createLogger('UseGitInventory');

export interface UseGitInventoryOptions {
  /**
   * Whether push invalidations may trigger inventory scans for this caller.
   * Defaults to `true`. Setting this false pauses effect-driven loads without
   * disabling an explicit {@link UseGitInventoryResult.refresh} call, and a
   * later false -> true transition performs a fresh load.
   */
  readonly active?: boolean;
  /**
   * Skip the mount-time load. OPT-IN, default `false` — the Changes surface
   * (`changes-surface.tsx`, the original caller) needs the inventory eagerly
   * for its source picker and its changed-files grouping, and must keep
   * loading on mount.
   *
   * A caller that only needs the inventory behind a user gesture (the git
   * panel's worktree dropdown, BST-1116 W6 review finding 4) passes `true` so
   * merely MOUNTING that surface no longer triggers a full repo/worktree scan
   * across every workspace root. Such a caller MUST invoke {@link
   * UseGitInventoryResult.refresh} from the gesture that reveals the data —
   * deferring without ever calling `refresh` would leave `inventory` `null`
   * forever, which is a silent disable, not a deferral.
   *
   * The deferred pre-first-load state is observable and must not be conflated
   * with "loading": `{ inventory: null, loading: false, error: null }` while
   * `available` is `true` means "not requested yet", and a consumer rendering
   * a reason for it has to say so (see `git-workbench-header.tsx`).
   */
  readonly deferInitialLoad?: boolean;
}

export interface UseGitInventoryResult {
  /** True when the desktop `window.changes` bridge is present and well-formed. */
  readonly available: boolean;
  /** The most recent load failure, or `null`. Cleared by a successful load. */
  readonly error: string | null;
  /**
   * `null` means "not yet resolved" (bridge absent, or the first load has not
   * settled) — never conflate it with a resolved inventory whose
   * `repositories` array is empty.
   */
  readonly inventory: GitInventory | null;
  /** True while a load is in flight. */
  readonly loading: boolean;
  /** Re-read the inventory. A no-op (resolves immediately) without a bridge. */
  readonly refresh: () => Promise<void>;
}

export function useGitInventory(options: UseGitInventoryOptions = {}): UseGitInventoryResult {
  const { active = true, deferInitialLoad = false } = options;
  // A false -> true transition is a new inventory activation. Results from an
  // older activation stay retained internally but are not exposed while the
  // mandatory re-entry refresh is unresolved.
  const activation = useMemo<object>(() => ({}), [active]);
  // Resolved ONCE per hook instance, not per render — see doc comment.
  const bridge = useMemo(() => resolveChangesBridge(), []);
  const [inventory, setInventory] = useState<GitInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolvedActivation, setResolvedActivation] = useState<object | null>(null);
  const generationRef = useRef(0);
  // True once ANY load has been requested (mount-time or a gesture's
  // `refresh()`). Gates push-driven refetches for deferred callers — see the
  // mount effect below.
  const loadRequestedRef = useRef(false);

  // EXTERNAL GIT ACTIVITY (BST-1161, spec §6): the inventory spans every
  // repository, so ANY accepted `changes:invalidated` event re-reads it. A
  // direct mount-effect dependency (same discipline as `use-changeset.ts`'s
  // inputs), so the effect below re-fires on each accepted event without
  // making the imperative `refresh` callback depend on an otherwise-unused
  // value.
  useChangesLiveRefreshSubscription();
  const anyInvalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);

  const refresh = useCallback(async (): Promise<void> => {
    loadRequestedRef.current = true;
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!bridge) {
      if (generation === generationRef.current) {
        setResolvedActivation(activation);
        setInventory(null);
        setError(null);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      const result = await bridge.inventory();
      if (generation !== generationRef.current) {
        return;
      }
      if (result.ok) {
        setResolvedActivation(activation);
        setInventory(result.value);
        setError(null);
      } else {
        setResolvedActivation(activation);
        setInventory(null);
        setError(result.error);
      }
      // Mirrored on the catch branch below, rather than a shared `finally`
      // (react-doctor/no-loading-flag-reset-outside-finally): both branches
      // reset `loading` only when this call is still the current generation
      // — a bare `finally` would reset it unconditionally, clearing the flag
      // out from under a NEWER call that is still genuinely in flight.
      setLoading(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.error('Failed to load git inventory', { error: caught });
      if (generation === generationRef.current) {
        setResolvedActivation(activation);
        setInventory(null);
        setError(message);
        setLoading(false);
      }
    }
  }, [activation, bridge]);

  useEffect(() => {
    // A surface that has gone inactive must stop paying for full inventory
    // scans even if it loaded earlier. Re-entry changes `active` back to true
    // and this same effect performs a fresh load.
    if (!active) {
      return;
    }
    // A deferred caller that has never requested a load stays unloaded even
    // across push invalidations — the deferral exists so merely mounting the
    // surface costs no repo scan, and a push event must not defeat it. Once a
    // load HAS been requested, invalidations keep the loaded inventory fresh.
    if (deferInitialLoad && !loadRequestedRef.current) {
      return;
    }
    void refresh();
  }, [active, anyInvalidationNonce, deferInitialLoad, refresh]);

  return {
    available: bridge !== null,
    error: resolvedActivation === activation ? error : null,
    inventory: resolvedActivation === activation ? inventory : null,
    loading,
    refresh,
  };
}
