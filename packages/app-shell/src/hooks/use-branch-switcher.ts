/**
 * The composer Branch chip's interactive half (spec §4.2).
 *
 * Reads the SAME data path the git panel's workbench header uses —
 * `window.git.repository(rootId)` for the recency-sorted local branches
 * (`for-each-ref --sort=-committerdate`), PLUS its own `window.git.status(rootId)`
 * read (the header already had one as a prop; this hook has no equivalent
 * parent, so it fetches its own) — and shapes both through the shared
 * `buildBranchSwitchModel` / `deriveBranchSwitchDirty`. No polling: both reads
 * are keyed on the same live-refresh nonce `useThreadCheckoutStatus` uses, and
 * every mutation refreshes the inventory so the next open cannot describe
 * pre-switch topology.
 *
 * BST-1447 fix round 2 — TWO SEPARATE DIRTINESSES, do not conflate them:
 * `checkout.dirty` (`WorkspaceBarCheckout`, `!status.clean` in
 * `useThreadCheckoutStatus`) is the workspace-bar DOT's own semantic and is
 * read here ONLY to gate whether a menu exists at all — never to gate a row.
 * The switch gate uses `deriveBranchSwitchDirty` over THIS hook's own status
 * read, so an untracked-only tree lights the dot but never disables a row,
 * matching Task 1's header fix exactly.
 *
 * `undefined` = no interactive menu (web, no git bridge, no primary root, a
 * primary root that is not a git repository (status probe only, no
 * repository read), or a failed repository/status read). A load failure is
 * logged and leaves the chip non-interactive — never rendered as an empty
 * branch list, which would read as "this repo has no branches". Only
 * MUTATIONS (switch, create, fetch) toast; a load failure has no user action
 * to attribute the toast to.
 */
import type { WorkspaceBarBranchMenu, WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import type { GitRepository, GitResult, GitStatusFile } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useGitInventory } from '../changes/use-git-inventory';
import { buildBranchSwitchModel, deriveBranchSwitchDirty } from '../git-panel/branch-switch-model';
import { resolveGitBridge } from '../git-panel/git-bridge';

const logger = createLogger('BranchSwitcher');

export interface UseBranchSwitcherArgs {
  /** Gates whether a menu exists at all; its `dirty` field is NOT read for the switch gate (see the ruling above). */
  readonly checkout: WorkspaceBarCheckout | undefined;
  /** The durable `roots.id` — the only id `window.git` understands. */
  readonly dbRootId: string | null;
  /** Supplied once the worktree capability exists (W3 Layer 6). */
  readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
}

function reportFailure(title: string, message: string): void {
  logger.warn(title, { error: message });
  toast({ description: message, title, variant: 'destructive' });
}

export function useBranchSwitcher(args: UseBranchSwitcherArgs): WorkspaceBarBranchMenu | undefined {
  const { checkout, dbRootId, onSwitchInNewWorktree } = args;
  // Resolved ONCE per hook instance, not per render — the bridge identity is
  // an effect input (same discipline as useGitInventory).
  const bridge = useMemo(() => resolveGitBridge(), []);
  const { refresh: refreshInventory } = useGitInventory({ deferInitialLoad: true });
  const anyInvalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  // Root-tagged, like `useThreadCheckoutStatus`: a repository resolved for one
  // root is never rendered under another, and a bail-out needs no clearing
  // setState (react-hooks/set-state-in-effect). `files` is the raw status
  // list — `deriveBranchSwitchDirty` runs over it below, not over `.clean`.
  const [loaded, setLoaded] = useState<{
    readonly dbRootId: string;
    readonly files: readonly GitStatusFile[];
    readonly repository: GitRepository;
  } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Self-contained repository gate (BST-1452 M2 rework — a prior version
  // gated this WHOLE effect on `useThreadCheckoutStatus`'s resolved
  // `checkout`, which serialized first-open readiness from max(a, b) to
  // a + b, since that hook's own `bridge.status` had to resolve before this
  // hook's pair could even start). `bridge.status` now fires unconditionally
  // — concurrent with `useThreadCheckoutStatus`'s independent status read,
  // restoring max(a, b) — and `bridge.repository` is fetched only once THIS
  // read confirms `isRepository`. A non-repository primary root is therefore
  // not a failure: it is logged only when the status read itself fails or
  // throws, and it never spawns a `bridge.repository` call.
  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    let cancelled = false;
    bridge
      .status(dbRootId)
      .then((statusResult) => {
        if (cancelled) {
          return;
        }
        if (!statusResult.ok) {
          logger.warn('branch switcher could not read status', {
            dbRootId,
            error: statusResult.error,
          });
          setLoaded(null);
          return;
        }
        if (!statusResult.value.isRepository) {
          // Not a git repository — expected, not a failure. No warn, and no
          // `bridge.repository` spawn: that read can never succeed here.
          setLoaded(null);
          return;
        }
        const { files } = statusResult.value;
        bridge
          .repository(dbRootId)
          .then((repositoryResult) => {
            if (cancelled) {
              return;
            }
            if (repositoryResult.ok) {
              setLoaded({ dbRootId, files, repository: repositoryResult.value });
              return;
            }
            // Genuinely unexpected: status just confirmed this root IS a
            // repository, so a failed repository read here is a real
            // failure worth surfacing, not "not a repository".
            logger.warn('branch switcher could not read the repository', {
              dbRootId,
              error: repositoryResult.error,
            });
            setLoaded(null);
          })
          .catch((error: unknown) => {
            if (!cancelled) {
              logger.warn('branch switcher repository read threw', { dbRootId, error });
              setLoaded(null);
            }
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.warn('branch switcher status read threw', { dbRootId, error });
          setLoaded(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [anyInvalidationNonce, bridge, dbRootId, reloadNonce]);

  const runMutation = useCallback(
    async (title: string, op: () => Promise<GitResult<unknown>>): Promise<void> => {
      setPending(true);
      try {
        const result = await op();
        if (!result.ok) {
          reportFailure(title, result.error);
          return;
        }
        // Worktree-affecting mutation: refresh the inventory AND re-read the
        // repository so the next open describes post-switch topology.
        await refreshInventory();
        setReloadNonce((nonce) => nonce + 1);
      } catch (error) {
        reportFailure(title, error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
    },
    [refreshInventory]
  );

  const repository = loaded?.dbRootId === dbRootId ? loaded.repository : null;
  const files = loaded?.dbRootId === dbRootId ? loaded.files : null;
  const defaultRemote = repository?.defaultRemote ?? null;

  const onSwitch = useCallback(
    (branch: string) => {
      if (bridge && dbRootId) {
        void runMutation('Switch branch failed', () => bridge.switchBranch(dbRootId, { branch }));
      }
    },
    [bridge, dbRootId, runMutation]
  );
  const onCreateBranch = useCallback(
    (name: string) => {
      if (bridge && dbRootId) {
        void runMutation('Create branch failed', () =>
          bridge.createBranch(dbRootId, { branch: name })
        );
      }
    },
    [bridge, dbRootId, runMutation]
  );
  const onFetch = useCallback(() => {
    if (bridge && dbRootId && defaultRemote) {
      void runMutation('Fetch failed', () => bridge.fetch(dbRootId, { remote: defaultRemote }));
    }
  }, [bridge, dbRootId, defaultRemote, runMutation]);

  return useMemo(() => {
    if (!(repository && files && checkout)) {
      return;
    }
    const model = buildBranchSwitchModel({
      branches: repository.branches,
      // Tracked-only, from THIS hook's own status read — never
      // `checkout.dirty` (see the doc comment and the ruling above).
      dirty: deriveBranchSwitchDirty({ files }),
      query,
      scope: repository.scope,
    });
    return {
      onCreateBranch,
      onFetch: defaultRemote ? onFetch : undefined,
      onQueryChange: setQuery,
      onSwitch,
      ...(onSwitchInNewWorktree ? { onSwitchInNewWorktree } : {}),
      pending,
      query,
      rows: model.rows,
      scopeReason: model.scopeReason,
    };
  }, [
    checkout,
    defaultRemote,
    files,
    onCreateBranch,
    onFetch,
    onSwitch,
    onSwitchInNewWorktree,
    pending,
    query,
    repository,
  ]);
}
