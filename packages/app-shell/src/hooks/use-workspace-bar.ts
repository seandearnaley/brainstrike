import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarCheckout,
  WorkspaceBarForge,
  WorkspaceBarMode,
  WorkspaceBarProps,
  WorkspaceBarRecentRoot,
  WorkspaceBarReveal,
  WorkspaceBarRoot,
} from '@brainstrike/assistant-ui';
import type { DbHandle } from '@brainstrike/db/react';
import { revealLabel } from '@brainstrike/file-explorer-ui/context-actions';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type { RecentRootEntry } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { resolvePlatformBridge } from '../platform-bridge';
import { useAssistantThreadRootBinding } from './use-assistant-thread-root-binding';
import { useThreadCheckout } from './use-thread-checkout';
import { useThreadCheckoutStatus } from './use-thread-checkout-status';
import type {
  ThreadCheckoutFolders,
  ThreadCheckoutRoot,
  ThreadCheckoutWrite,
} from './use-thread-folders-write';
import { useWorkspaceBarForge } from './use-workspace-bar-forge';
import { useWorkspaceBarMode } from './use-workspace-bar-mode';
import { copyWorkspaceBarValue } from './workspace-bar-clipboard';

const logger = createLogger('WorkspaceBar');

interface WorkspaceBarRootDescriptor {
  readonly displayName: string;
  readonly path: string;
}

export interface UseWorkspaceBarArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly currentMainRoot?: AssistantOperatingRootCandidate | undefined;
  readonly database: DbHandle | null;
  readonly memoryResourceId: string;
  readonly rootDescriptors: Readonly<Record<string, WorkspaceBarRootDescriptor>> | undefined;
  readonly selectedMemoryThreadId: string | undefined;
}

interface RootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

interface ResolvedSecondaryRoots {
  readonly error: boolean;
  readonly key: string;
  readonly roots: readonly WorkspaceBarRoot[];
}

const EMPTY_SECONDARY_ROOT_IDS: readonly string[] = [];
// Shared empty results: `setState` with a fresh `[]` would defeat React's
// Object.is bail-out and re-render on every settle.
const NO_ROOTS: readonly WorkspaceBarRoot[] = [];
const NO_RECENT_ENTRIES: readonly RecentRootEntry[] = [];
// Root ids are uuidv7, so a space can never occur inside one — the joined key
// is a faithful VALUE identity for the id list. (If ids ever gain a format that
// can contain a space, this key stops distinguishing `['a b']` from `['a','b']`
// and must change with it.)
const SECONDARY_ID_SEPARATOR = ' ';

/** What a queued write persisted, for the next write in the queue to chain on. */
interface ThreadFoldersWriteTail {
  readonly checkoutLocalRootId: string | undefined;
  readonly ids: readonly string[];
  readonly primaryRoot: ThreadCheckoutRoot | undefined;
  readonly primaryRootId: string | undefined;
  readonly secondaryRoots: readonly ThreadCheckoutRoot[];
  /** The thread the ids belong to — they are meaningless for any other. */
  readonly threadId: string;
}

/**
 * A folder's durable `roots` row is written by the roots-reconciliation effect
 * in `workspace-collection-sync-provider.tsx`, which runs only AFTER
 * `addRootDirectory()` has resolved and re-rendered the provider. Looking the
 * row up in the same microtask therefore loses that race, and the folder mounts
 * globally while never being attached to the thread. Re-mounting a
 * `'disconnected'` root has the same shape (the row is flipped back to 'live'
 * by the same effect). So the lookup polls on a bounded budget, mirroring the
 * transient-root retry in `git-panel/use-git-panel.ts`.
 *
 * FOLLOW-UP (deliberately out of scope here): the canonical fix is a
 * promise-based "await root registration" seam exported by the reconciliation
 * layer (`roots/use-roots-reconciliation.ts`), so a caller can await the
 * registration its own action triggered instead of polling for the side effect.
 */
const ROOT_ROW_RETRY_LIMIT = 20;
const ROOT_ROW_RETRY_DELAY_MS = 250;

type RootRowLookup =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resolved'; readonly rootId: string }
  | { readonly error: unknown; readonly kind: 'unresolved' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondaryRootsStatus(
  secondaryRootIds: readonly string[],
  secondaryRootIdsKey: string,
  resolvedSecondaries: ResolvedSecondaryRoots | null
): 'error' | 'pending' | 'ready' {
  if (secondaryRootIds.length === 0) {
    return 'ready';
  }
  if (resolvedSecondaries?.key !== secondaryRootIdsKey) {
    return 'pending';
  }
  return resolvedSecondaries.error ? 'error' : 'ready';
}

/**
 * Electron's `ipcRenderer.invoke` re-throws a main-process rejection in the
 * renderer with its own envelope prepended — `Error invoking remote method
 * '<channel>': Error: <the real message>`. That prefix is IPC plumbing, not
 * something a user can act on, and it pushes the actual remedy off the front
 * of a toast. Stripped here, at the one place a failure becomes user-facing
 * text; the message itself is never rewritten.
 */
const IPC_INVOKE_ENVELOPE = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u;

/**
 * The text a user is shown when an action fails. Always the ORIGINATING
 * message — the main process explains what to do about a revoked grant, and a
 * generic "something went wrong" would throw that remedy away.
 */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(IPC_INVOKE_ENVELOPE, '');
}

/**
 * A folder write raised before the selected thread's row reached the store.
 * Refusing is the same rule `persistThreadRootBinding` applies — an absent
 * folder set is indistinguishable from an empty one — but unlike a thread
 * switch the user asked for this, so it is logged and rejected for the
 * action-specific caller to surface.
 */
function refuseWriteBeforeThreadMetadata(): never {
  logger.error('Cannot update thread folders before the selected thread metadata is loaded');
  throw new Error("This thread's folders have not loaded yet — try again in a moment.");
}

/**
 * The folder set a queued write derives its next value from. Only a tail from
 * THIS thread describes this write's starting point — the hook is long-lived,
 * so the ref outlives a thread switch and an unconditional chain would write
 * thread A's folder set onto thread B. A chained tail is never "pending": it
 * describes a write that already landed.
 */
function writeStartingPoint(
  live: ThreadCheckoutFolders,
  tail: ThreadFoldersWriteTail | null,
  startedForThreadId: string
): ThreadCheckoutFolders {
  return tail?.threadId === startedForThreadId
    ? {
        checkoutLocalRootId: tail.checkoutLocalRootId,
        metadataPending: false,
        primaryRoot: tail.primaryRoot,
        primaryRootId: tail.primaryRootId,
        secondaryRootIds: tail.ids,
        secondaryRoots: tail.secondaryRoots,
        secondaryRootsError: false,
        secondaryRootsPending: false,
        threadId: live.threadId,
      }
    : live;
}

class MakePrimaryDerivationError extends Error {
  readonly reason: 'current-primary' | 'secondary';
  readonly rootId: string | undefined;

  constructor(
    message: string,
    reason: 'current-primary' | 'secondary',
    rootId: string | undefined
  ) {
    super(message);
    this.name = 'MakePrimaryDerivationError';
    this.reason = reason;
    this.rootId = rootId;
  }
}

export function deriveMakePrimary(
  current: ThreadCheckoutFolders,
  rootId: string
): ThreadCheckoutWrite {
  const next = current.secondaryRoots.find((root) => root.rootId === rootId);
  const nextPath = next?.path;
  if (!(next && nextPath)) {
    if (current.secondaryRootsError) {
      throw new Error('Folders failed to load — reopen the thread or restart to retry.');
    }
    if (current.secondaryRootsPending) {
      throw new Error('Folders are still loading — try again in a moment.');
    }
    throw new MakePrimaryDerivationError(
      `Could not make primary: secondary root ${rootId} is unknown or has no path.`,
      'secondary',
      rootId
    );
  }
  const demotesPrimary = Boolean(current.primaryRootId && current.primaryRootId !== rootId);
  const currentPrimaryPath = current.primaryRoot?.path;
  if (
    demotesPrimary &&
    (!current.primaryRoot ||
      current.primaryRoot.rootId !== current.primaryRootId ||
      !currentPrimaryPath)
  ) {
    throw new MakePrimaryDerivationError(
      `Could not make primary: current primary root ${current.primaryRootId ?? '(unknown)'} is unknown or has no path.`,
      'current-primary',
      current.primaryRootId
    );
  }
  const demoted =
    demotesPrimary && current.primaryRoot && currentPrimaryPath
      ? [{ ...current.primaryRoot, path: currentPrimaryPath }]
      : [];
  const secondaryRoots = [
    ...current.secondaryRoots.filter((root) => root.rootId !== rootId),
    ...demoted,
  ];
  return {
    binding: {
      operatingRootDisplayName: next.displayName,
      operatingRootId: rootId,
      operatingRootPath: nextPath,
    },
    checkoutLocalRootId: current.checkoutLocalRootId,
    ids: [
      ...current.secondaryRootIds.filter((id) => id !== rootId),
      ...demoted.map((root) => root.rootId),
    ],
    primaryRoot: { ...next, path: nextPath },
    primaryRootId: rootId,
    secondaryRoots,
  };
}

/**
 * Gated on `primaryRoot`, not just on `checkout`: the branch chip describes
 * the primary folder, so it must never outlive the row it describes — a
 * resolved id whose `operatingRoot` has not landed yet would otherwise render
 * a branch with no folder beside it. Returns a ready-to-spread partial (see
 * `branchMenuEntry` below for why) rather than a plain conditional value.
 */
function checkoutEntry(
  primaryRoot: WorkspaceBarRoot | undefined,
  checkout: WorkspaceBarCheckout | undefined
): { readonly checkout?: WorkspaceBarCheckout } {
  return primaryRoot && checkout ? { checkout } : {};
}

/**
 * Gated on the same `primaryRoot && checkout` pair as the chip itself: an
 * interactive menu for a chip that is not rendered is unreachable state.
 * Returns a ready-to-spread partial so the call site in `useWorkspaceBar`
 * carries no conditional of its own — the gate's branches are pulled out
 * entirely rather than merely relocated, keeping that hook's
 * cognitive-complexity budget untouched by this wiring.
 */
function branchMenuEntry(
  primaryRoot: WorkspaceBarRoot | undefined,
  checkout: WorkspaceBarCheckout | undefined,
  branchMenu: WorkspaceBarBranchMenu | undefined
): { readonly branchMenu?: WorkspaceBarBranchMenu } {
  return primaryRoot && checkout && branchMenu ? { branchMenu } : {};
}

function forgeEntry(forge: WorkspaceBarForge | undefined): { readonly forge?: WorkspaceBarForge } {
  return forge ? { forge } : {};
}

function modeEntry(mode: WorkspaceBarMode | undefined): { readonly mode?: WorkspaceBarMode } {
  return mode ? { mode } : {};
}

/**
 * Logs ONCE per path when the thread's primary folder is not mounted in this
 * workspace (bound elsewhere, or unmounted since), so no descriptor supplies an
 * adapter rootId. Nothing is invented for it — but the gap is observable: that
 * root's branch chip tracks git-metadata pushes only, never working-tree edits.
 */
function useUnmappedPrimaryRootNotice(
  primaryRootPath: string | undefined,
  primaryAdapterRootId: string | null
): void {
  const loggedPathsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!primaryRootPath || primaryAdapterRootId) {
      return;
    }
    loggedPathsRef.current ??= new Set<string>();
    const loggedPaths = loggedPathsRef.current;
    if (loggedPaths.has(primaryRootPath)) {
      return;
    }
    loggedPaths.add(primaryRootPath);
    logger.debug(
      'the primary root is not mounted in this workspace; working-tree edits are not mapped to its branch chip',
      { path: primaryRootPath }
    );
  }, [primaryAdapterRootId, primaryRootPath]);
}

/**
 * The primary's ADAPTER rootId, used for the working-tree refresh registration
 * and nothing else — `null` when no mounted root has that path.
 *
 * `rootDescriptors` is keyed by adapter rootId, and PATH is the ONLY thing the
 * adapter and DB id spaces share, so the primary's durable `roots.id` cannot
 * look it up. That is the whole point: for a legacy path-matched root the two
 * ids differ, and registering the durable one matches nothing. Path-matching
 * covers the persisted-binding and MAIN-fallback cases at once — the MAIN
 * root's descriptor is keyed by `activeRootIds[0]`, and its path IS the MAIN
 * path.
 */
function usePrimaryAdapterRootId(
  rootDescriptors: Readonly<Record<string, WorkspaceBarRootDescriptor>> | undefined,
  primaryRootPath: string | undefined
): string | null {
  const adapterRootIdByPath = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const [adapterRootId, descriptor] of Object.entries(rootDescriptors ?? {})) {
      byPath.set(descriptor.path, adapterRootId);
    }
    return byPath;
  }, [rootDescriptors]);
  const primaryAdapterRootId = primaryRootPath
    ? (adapterRootIdByPath.get(primaryRootPath) ?? null)
    : null;
  useUnmappedPrimaryRootNotice(primaryRootPath, primaryAdapterRootId);
  return primaryAdapterRootId;
}

/**
 * The durable `roots.id` for a path, waiting a bounded window for
 * reconciliation to insert (or re-flip to `'live'`) the row. Never rejects:
 * every outcome — including exhaustion — is returned so the caller can surface
 * it. Exhaustion is NOT a silent no-op for any caller.
 */
async function resolveRootIdAfterReconciliation(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate,
  isCancelled: () => boolean
): Promise<RootRowLookup> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ROOT_ROW_RETRY_LIMIT; attempt += 1) {
    if (attempt > 0) {
      await delay(ROOT_ROW_RETRY_DELAY_MS);
    }
    if (isCancelled()) {
      return { kind: 'cancelled' };
    }
    try {
      const binding = await resolveAssistantOperatingRootBinding(database, candidate);
      return { kind: 'resolved', rootId: binding.rootId };
    } catch (error) {
      lastError = error;
    }
  }
  return isCancelled() ? { kind: 'cancelled' } : { error: lastError, kind: 'unresolved' };
}

/**
 * Everything the composer WorkspaceBar needs, from the THREAD's point of view.
 *
 * - PRIMARY = the thread's persisted operating-root binding, else the current
 *   MAIN root — shown at ANY root count (orientation, not disambiguation).
 *   Its `rootId` is ALWAYS a durable `roots.id`: with no persisted binding the
 *   MAIN root's row is resolved by PATH, never borrowed from the file-system
 *   adapter's own id space (`window.git.status` and `secondaryRootIds` both
 *   speak the DB space). Re-resolving that row on `anyInvalidationNonce` is
 *   OPPORTUNISTIC — a row written with no accompanying changes invalidation
 *   stays unseen until the next one — and remains so until the await-root-
 *   registration seam below exists.
 * - SECONDARIES = `metadata.secondaryRootIds` resolved against the `roots`
 *   table for display. The assistant panel renders as a sibling of the
 *   RootIdentityProvider subtree, so there is no root-identity context to read
 *   here; the durable `roots` rows are the display source.
 * - RECENTS = main's recent-roots ledger (desktop only) minus folders already
 *   mounted in this workspace.
 *
 * "Make primary" re-binds the THREAD through the same three `operatingRoot*`
 * metadata keys `persistThreadRootBinding` writes — it NEVER touches the global
 * MAIN root (`setMainRoot`), which is a workspace-wide ordering choice.
 * "Add folder" adds the folder globally (the existing multi-root flow) AND
 * records it as a secondary of this thread.
 *
 * No silent degradation: every failed read or write logs with context and the
 * bar renders nothing rather than invented state; the failures a user would
 * care about (a folder added but not attached, a copy that did not happen) are
 * surfaced as toasts.
 */
export function useWorkspaceBar(args: UseWorkspaceBarArgs): WorkspaceBarProps {
  const {
    assistantThreadRepository,
    currentMainRoot,
    database,
    memoryResourceId,
    rootDescriptors,
    selectedMemoryThreadId,
  } = args;
  const fileSystem = useFileSystem();
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const selectedThread = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((thread) => thread.id === selectedMemoryThreadId)
    : undefined;
  const checkoutLocalRootId =
    selectedThread?.metadata?.checkoutMode === 'worktree'
      ? selectedThread.metadata.checkoutLocalRootId
      : undefined;
  const threadMetadataSecondaryRootIds = selectedThread?.metadata?.secondaryRootIds;
  // Watching is opt-out. This matches useForgeRunEvents, so a thread created
  // before the metadata field existed still receives forge observations.
  const forgePrWatched = selectedThread?.metadata?.forgePrWatch !== false;
  const secondaryRootIdsKey = (threadMetadataSecondaryRootIds ?? EMPTY_SECONDARY_ROOT_IDS).join(
    SECONDARY_ID_SEPARATOR
  );
  // Value-keyed identity: a thread-object refresh carrying an EQUAL id list
  // must not re-run the roots query or rebuild the action callbacks.
  const secondaryRootIds = useMemo<readonly string[]>(
    () =>
      secondaryRootIdsKey === ''
        ? EMPTY_SECONDARY_ROOT_IDS
        : secondaryRootIdsKey.split(SECONDARY_ID_SEPARATOR),
    [secondaryRootIdsKey]
  );
  const { operatingRoot, selectedThreadMetadataPending, threadRootBinding } =
    useAssistantThreadRootBinding({
      assistantThreadRepository,
      ...(currentMainRoot ? { currentMainRoot } : {}),
      database,
      memoryResourceId,
      selectedMemoryThreadId,
    });

  // Cancellation for an in-flight reconciliation wait. Unmount and thread
  // identity are SEPARATE signals on purpose: a single flag reset by an effect
  // keyed on the thread id is a no-op, because React runs the cleanup AND the
  // new effect body in the same commit — the flag is back to `false` before any
  // pending retry observes the switch, and the in-flight write (which captured
  // thread A's callbacks) then replaces thread B's folder set with thread A's.
  // The unmount flag is re-armed on mount so StrictMode's double-invoke does
  // not leave the hook permanently "cancelled".
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  const activeThreadIdRef = useRef(selectedMemoryThreadId);
  useEffect(() => {
    activeThreadIdRef.current = selectedMemoryThreadId;
  }, [selectedMemoryThreadId]);

  // The primary's DURABLE id. With a persisted binding it is already a
  // `roots.id`; without one the MAIN root's row is resolved by PATH — the only
  // thing the adapter and DB id spaces share. State is keyed by the path so a
  // resolved id is never rendered under a different root, and an unresolvable
  // path leaves `primaryRoot`/`checkout` undefined rather than inventing an id.
  const bindingRootId = threadRootBinding?.rootId;
  const mainRootPath = currentMainRoot?.path;
  const mainRootDisplayName = currentMainRoot?.displayName;
  const [mainRootRow, setMainRootRow] = useState<{
    readonly path: string;
    readonly rootId: string;
  } | null>(null);
  const warnedMainRootPathsRef = useRef<Set<string> | null>(null);
  // Exhausting the retry budget must not be terminal for the session: the same
  // reconciliation signal the checkout chip refetches on re-triggers the
  // resolve, so a row written after the budget ran out is still picked up.
  // Read-only here — the refcounted subscription that FEEDS this nonce is
  // acquired by `useThreadCheckoutStatus` below, which this hook always calls.
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  useEffect(() => {
    // No clearing branch: the state is PATH-tagged and the read below ignores a
    // row resolved for any other path, so a bail-out needs no synchronous
    // setState (react-hooks/set-state-in-effect).
    if (bindingRootId || !(database && mainRootPath && mainRootDisplayName)) {
      return;
    }
    let cancelled = false;
    // Never rejects — every failure is carried in the returned outcome.
    void resolveRootIdAfterReconciliation(
      database,
      { displayName: mainRootDisplayName, path: mainRootPath },
      () => cancelled
    ).then((lookup) => {
      if (lookup.kind === 'cancelled') {
        return;
      }
      if (lookup.kind === 'unresolved') {
        setMainRootRow(null);
        warnedMainRootPathsRef.current ??= new Set<string>();
        const warnedPaths = warnedMainRootPathsRef.current;
        if (!warnedPaths.has(mainRootPath)) {
          warnedPaths.add(mainRootPath);
          logger.warn(
            'the MAIN root has no unique live roots row; the workspace bar shows no primary',
            { error: lookup.error, path: mainRootPath }
          );
        }
        return;
      }
      setMainRootRow((previous) =>
        previous?.path === mainRootPath && previous.rootId === lookup.rootId
          ? previous
          : { path: mainRootPath, rootId: lookup.rootId }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bindingRootId, database, invalidationNonce, mainRootDisplayName, mainRootPath]);
  // Optional chain on BOTH sides: with no MAIN root at all the two paths are
  // both `undefined` and would trivially "match" — `?.` keeps that undefined.
  const primaryRootId =
    bindingRootId ?? (mainRootRow?.path === mainRootPath ? mainRootRow?.rootId : undefined);
  const primaryRoot: WorkspaceBarRoot | undefined =
    operatingRoot && primaryRootId
      ? {
          displayName: operatingRoot.displayName,
          ...(operatingRoot.path ? { path: operatingRoot.path } : {}),
          rootId: primaryRootId,
        }
      : undefined;

  // Id-list-tagged, for the same reason `mainRootRow` is path-tagged: a
  // resolution for one id list is never rendered under another, and a bail-out
  // needs no clearing setState (react-hooks/set-state-in-effect).
  const [resolvedSecondaries, setResolvedSecondaries] = useState<ResolvedSecondaryRoots | null>(
    null
  );
  const secondaryRoots =
    database && resolvedSecondaries?.key === secondaryRootIdsKey
      ? resolvedSecondaries.roots
      : NO_ROOTS;
  const resolvedSecondaryRootsStatus = secondaryRootsStatus(
    secondaryRootIds,
    secondaryRootIdsKey,
    resolvedSecondaries
  );
  const secondaryRootsError = resolvedSecondaryRootsStatus === 'error';
  const secondaryRootsPending = resolvedSecondaryRootsStatus === 'pending';
  useEffect(() => {
    if (!(database && secondaryRootIds.length > 0)) {
      return;
    }
    let cancelled = false;
    database
      .query<RootRow>(
        'SELECT id, display_name AS "displayName", path FROM roots WHERE id = ANY($1::text[])',
        [secondaryRootIds]
      )
      .then((result) => {
        if (cancelled) {
          return;
        }
        const byId = new Map(result.rows.map((row) => [row.id, row]));
        setResolvedSecondaries({
          error: false,
          key: secondaryRootIdsKey,
          roots: secondaryRootIds.flatMap((id) => {
            const row = byId.get(id);
            if (!row) {
              logger.warn('secondary root id has no roots row', { id });
              return [];
            }
            return [
              {
                displayName: row.displayName,
                ...(row.path ? { path: row.path } : {}),
                rootId: row.id,
              },
            ];
          }),
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to load the thread secondary roots', { error });
          // Tagged with the key it failed for, so the failure is not retried on
          // every render and no other id list inherits an empty result.
          setResolvedSecondaries({ error: true, key: secondaryRootIdsKey, roots: NO_ROOTS });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, secondaryRootIds, secondaryRootIdsKey]);

  // The ledger is read once per capability identity, and re-read on demand
  // (see `refreshRecentRoots`) after this session records a new grant; which
  // entries are still OFFERABLE is a separate, render-time question (a folder
  // mounted or disconnected this session must leave/re-enter the list without
  // another IPC round-trip).
  const listRecentRoots = fileSystem.listRecentRoots;
  // Source-tagged: entries read through one capability are never rendered after
  // the adapter swaps it out, so losing the capability needs no clearing
  // setState (react-hooks/set-state-in-effect).
  const [loadedRecents, setLoadedRecents] = useState<{
    readonly entries: readonly RecentRootEntry[];
    readonly source: NonNullable<typeof listRecentRoots>;
  } | null>(null);
  // `listRecentRoots` is checked FIRST: with no capability it is `undefined`,
  // and `null?.source` would be `undefined` too — the two must not "match".
  const recentEntries =
    listRecentRoots && loadedRecents?.source === listRecentRoots
      ? loadedRecents.entries
      : NO_RECENT_ENTRIES;
  // Shared by the mount-time load below and by a same-session grant (Add
  // folder / re-mounting a recent) — main appends to `recentRootsList`
  // synchronously inside `addRoot()`, before the grant's promise resolves back
  // to the renderer, so a caller-driven refresh right after that resolution
  // always observes the new entry. `isCancelled` lets each caller supply its
  // own "still relevant" check (an effect generation flag for the mount-time
  // load, `unmountedRef` for a grant-triggered refresh).
  const refreshRecentRoots = useCallback(
    (isCancelled: () => boolean) => {
      if (!listRecentRoots) {
        return;
      }
      listRecentRoots()
        .then((entries) => {
          if (!isCancelled()) {
            setLoadedRecents({ entries, source: listRecentRoots });
          }
        })
        .catch((error: unknown) => {
          if (!isCancelled()) {
            logger.error('failed to list the recent roots', { error });
            setLoadedRecents({ entries: NO_RECENT_ENTRIES, source: listRecentRoots });
          }
        });
    },
    [listRecentRoots]
  );
  useEffect(() => {
    let cancelled = false;
    refreshRecentRoots(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refreshRecentRoots]);
  const mountedPaths = useMemo(
    () => new Set(Object.values(rootDescriptors ?? {}).map((descriptor) => descriptor.path)),
    [rootDescriptors]
  );
  const recentRoots = useMemo<readonly WorkspaceBarRecentRoot[]>(
    () =>
      recentEntries.flatMap((entry) =>
        mountedPaths.has(entry.path) ? [] : [{ displayName: entry.displayName, path: entry.path }]
      ),
    [mountedPaths, recentEntries]
  );

  const writeThreadFolders = useCallback(
    async (ids: readonly string[], binding: Record<string, string> = {}) => {
      if (!(assistantThreadRepository && selectedMemoryThreadId)) {
        throw new Error('Cannot update the thread folder set without an active thread.');
      }
      await updateThreadMetadata(
        assistantThreadRepository,
        memoryResourceId,
        selectedMemoryThreadId,
        { ...binding, secondaryRootIds: [...ids] }
      );
    },
    [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId, updateThreadMetadata]
  );

  // The reconciliation wait below can span seconds, so the folder set captured
  // when the user clicked may be stale by the time the write happens (a removal
  // in between would be undone). Read the CURRENT set through this ref instead.
  // It carries the thread it describes, so a queued write can prove it is still
  // deriving from the thread it was started for.
  const threadFoldersRef = useRef<ThreadCheckoutFolders>({
    checkoutLocalRootId,
    metadataPending: selectedThreadMetadataPending,
    primaryRoot,
    primaryRootId,
    secondaryRootIds,
    secondaryRoots,
    secondaryRootsError,
    secondaryRootsPending,
    threadId: selectedMemoryThreadId,
  });
  useEffect(() => {
    threadFoldersRef.current = {
      checkoutLocalRootId,
      metadataPending: selectedThreadMetadataPending,
      primaryRoot,
      primaryRootId,
      secondaryRootIds,
      secondaryRoots,
      secondaryRootsError,
      secondaryRootsPending,
      threadId: selectedMemoryThreadId,
    };
  }, [
    checkoutLocalRootId,
    primaryRoot,
    primaryRootId,
    secondaryRootIds,
    secondaryRoots,
    secondaryRootsError,
    secondaryRootsPending,
    selectedMemoryThreadId,
    selectedThreadMetadataPending,
  ]);

  /**
   * Serializes thread-folder writes. Two Add-folder clicks whose lookups settle
   * in the same tick would otherwise both derive from the pre-click set and the
   * second would drop the first's id. So a queued write derives from what the
   * PREVIOUS queued write actually persisted — its ids AND the primary it
   * installed — because the store update behind `threadFoldersRef` has not
   * reached the render at that point in the microtask chain.
   *
   * The tail is thread-scoped and drainable, both deliberately:
   *
   * - it carries the thread it describes and is consumed ONLY by a write
   *   started for that same thread. This hook is long-lived in the wrapper, so
   *   the ref outlives a thread switch; consuming it unconditionally would
   *   write thread A's folder set onto thread B.
   * - `pendingWriteCountRef` clears the tail the moment the queue drains, so
   *   the next write reads LIVE state rather than a stale value from an
   *   already-settled round of writes (metadata changed by another surface in
   *   between must not be reverted). The tail is a hand-off between writes that
   *   overlap, never a cache of the persisted state.
   *
   * A write whose thread is no longer selected — or that outlives the hook —
   * is skipped rather than landed on whatever thread is current now.
   */
  const writeTailRef = useRef<Promise<ThreadFoldersWriteTail | null> | null>(null);
  const pendingWriteCountRef = useRef(0);
  const enqueueThreadFoldersWrite = useCallback(
    (
      startedForThreadId: string | undefined,
      // Contract for every derive passed to this queue: returning null is a
      // deliberate no-op only for a write that was never asked for by the user
      // this tick (an idempotent dedup or a thread-switch/unmount race). A
      // refusal of an explicit click must throw: null resolves the caller's
      // promise successfully, while a rejection is visible to its catch.
      derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
    ): Promise<void> => {
      const previous = writeTailRef.current;
      pendingWriteCountRef.current += 1;
      const settled = (async (): Promise<ThreadFoldersWriteTail | null> => {
        const tail = previous ? await previous : null;
        const live = threadFoldersRef.current;
        // A write with NO thread is a caller bug, not an expected outcome: the
        // action fired while nothing was selected. Skipping it silently is what
        // makes "the folder did not attach" look like a UI glitch.
        if (!startedForThreadId) {
          logger.error('Cannot update thread folders without an active thread');
          throw new Error('Cannot update thread folders without an active thread.');
        }
        // A thread switch or an unmount, by contrast, is the ordinary reason a
        // queued write no longer applies — the state it would derive from is no
        // longer this write's. Those stay silent.
        if (unmountedRef.current || live.threadId !== startedForThreadId) {
          return tail;
        }
        // The same refusal `persistThreadRootBinding` makes: the thread's row
        // has not landed, so its folder set reads as empty for a reason that
        // has nothing to do with its folders. Writing now would persist that
        // emptiness over the real set — and unlike a thread switch, the user
        // asked for this and has to be told it did not happen.
        if (live.metadataPending) {
          refuseWriteBeforeThreadMetadata();
        }
        const request = derive(writeStartingPoint(live, tail, startedForThreadId));
        if (!request) {
          return tail;
        }
        await writeThreadFolders(request.ids, request.binding);
        return {
          checkoutLocalRootId: request.checkoutLocalRootId,
          ids: request.ids,
          primaryRoot: request.primaryRoot,
          primaryRootId: request.primaryRootId,
          secondaryRoots: request.secondaryRoots,
          threadId: startedForThreadId,
        };
      })();
      // The tail must never reject: the next write awaits it, and a failed
      // write means "fall back to the live set", not "poison the queue".
      const tailed = settled.then(
        (tail) => tail,
        () => null
      );
      writeTailRef.current = tailed;
      void tailed.then(() => {
        pendingWriteCountRef.current -= 1;
        if (pendingWriteCountRef.current === 0) {
          writeTailRef.current = null;
        }
      });
      return settled.then(() => undefined);
    },
    [writeThreadFolders]
  );

  const resolveRootIdForPath = useCallback(
    async (path: string, displayName: string): Promise<string> => {
      if (!database) {
        throw new Error('Cannot resolve a worktree root before the workspace database is ready.');
      }
      const startedForThreadId = selectedMemoryThreadId;
      const isCancelled = () =>
        unmountedRef.current || activeThreadIdRef.current !== startedForThreadId;
      const lookup = await resolveRootIdAfterReconciliation(
        database,
        { displayName, path },
        isCancelled
      );
      if (lookup.kind === 'cancelled' || isCancelled()) {
        throw new Error(
          'Worktree root resolution was cancelled because the active thread changed.'
        );
      }
      if (lookup.kind === 'unresolved') {
        throw lookup.error;
      }
      return lookup.rootId;
    },
    [database, selectedMemoryThreadId]
  );

  const recordAddedAsSecondary = useCallback(
    async (handle: { readonly name: string; readonly path: string }) => {
      // Main already appended this grant to `recentRootsList` by the time the
      // add call resolved into `handle` — refresh the bar's snapshot now so a
      // folder granted and then disconnected THIS session still shows up under
      // Recent without a remount/reload. Session-wide, not thread-scoped: it
      // must run even if the thread changes before the rest of this function's
      // (thread-specific) work below is cancelled.
      refreshRecentRoots(() => unmountedRef.current);
      if (!database) {
        throw new Error('Cannot record a thread folder before the workspace database is ready.');
      }
      // Compare the CAPTURED thread against the live one: a switch away is what
      // cancels, and it must stay observable after the ref catches up.
      const startedForThreadId = selectedMemoryThreadId;
      const isCancelled = () =>
        unmountedRef.current || activeThreadIdRef.current !== startedForThreadId;
      const lookup = await resolveRootIdAfterReconciliation(
        database,
        { displayName: handle.name, path: handle.path },
        isCancelled
      );
      if (lookup.kind === 'cancelled') {
        return;
      }
      // Re-checked AFTER a successful lookup too: a switch landing during the
      // final query would otherwise still let the write through.
      if (isCancelled()) {
        return;
      }
      if (lookup.kind === 'unresolved') {
        logger.error('an added folder never reconciled into the workspace roots table', {
          error: lookup.error,
          path: handle.path,
        });
        toast({
          description: `"${handle.name}" is still available as a workspace folder, but this thread was not updated to include it.`,
          title: 'Folder added, but not attached to this thread',
          variant: 'destructive',
        });
        return;
      }
      await enqueueThreadFoldersWrite(startedForThreadId, (current) => {
        if (
          lookup.rootId === current.primaryRootId ||
          current.secondaryRootIds.includes(lookup.rootId)
        ) {
          return null;
        }
        return {
          checkoutLocalRootId: current.checkoutLocalRootId,
          ids: [...current.secondaryRootIds, lookup.rootId],
          primaryRoot: current.primaryRoot,
          primaryRootId: current.primaryRootId,
          secondaryRoots: [
            ...current.secondaryRoots,
            { displayName: handle.name, path: handle.path, rootId: lookup.rootId },
          ],
        };
      });
    },
    [database, enqueueThreadFoldersWrite, refreshRecentRoots, selectedMemoryThreadId]
  );

  const addRootDirectory = fileSystem.addRootDirectory;
  const onAddFolder = useCallback(() => {
    addRootDirectory()
      .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
      .catch((error: unknown) => {
        logger.error('Add folder failed', { error });
        toast({
          description: describeFailure(error),
          title: 'Add folder failed',
          variant: 'destructive',
        });
      });
  }, [addRootDirectory, recordAddedAsSecondary]);

  const addRootDirectoryByPath = fileSystem.addRootDirectoryByPath;
  // Always defined; the CAPABILITY decides whether the prop is supplied (see
  // the return). Gating the spread on `addRootDirectoryByPath` rather than on
  // this callback keeps the render-time condition free of the ref-derived
  // values `recordAddedAsSecondary` closes over (react-hooks/refs).
  const onAddRecent = useCallback(
    (path: string): void => {
      if (!addRootDirectoryByPath) {
        logger.error('Recent folder re-mount requested without the picker-less capability', {
          path,
        });
        return;
      }
      addRootDirectoryByPath(path)
        .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
        .catch((error: unknown) => {
          logger.error('Recent folder could not be re-mounted', { error, path });
          toast({
            description: describeFailure(error),
            title: "Couldn't open recent folder",
            variant: 'destructive',
          });
        });
    },
    [addRootDirectoryByPath, recordAddedAsSecondary]
  );

  const onMakePrimary = useCallback(
    (rootId: string) => {
      // ONE metadata write: the thread binding keys and the secondary set move
      // together, so the store never shows an intermediate state with the new
      // primary still listed as a secondary. These are the same three
      // operatingRoot* keys persistThreadRootBinding writes (the sanitizer's
      // all-or-nothing rule), through the same store action — the global MAIN
      // root is deliberately untouched.
      void enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
        // TODO(BST-1390): if the thread is currently in worktree checkout mode
        // (metadata.checkoutMode === 'worktree'), promoting a plain secondary
        // root to primary here leaves checkoutMode stuck at 'worktree' while
        // the primary is no longer the worktree — a state-consistency bug.
        // Deferred: fixing it needs either an implicit hand-off folded into
        // this same write, or disabling "Make primary" for non-worktree
        // secondaries while in worktree mode with a visible reason. Needs a
        // decision, not just a patch — see the BST-1390 Task 17 reviewer
        // addendum, item (a).
        try {
          return deriveMakePrimary(current, rootId);
        } catch (error) {
          if (error instanceof MakePrimaryDerivationError) {
            const message =
              error.reason === 'secondary'
                ? 'Make primary: unknown secondary root, or a root with no path'
                : 'Make primary: current primary root is unknown or has no path';
            logger.error(message, { rootId: error.rootId });
          }
          throw error;
        }
      }).catch((error: unknown) => {
        logger.error('Make primary failed', { error, rootId });
        toast({
          description: describeFailure(error),
          title: 'Make primary failed',
          variant: 'destructive',
        });
      });
    },
    [enqueueThreadFoldersWrite, selectedMemoryThreadId]
  );

  const onRemoveSecondary = useCallback(
    (rootId: string) => {
      // TODO(BST-1390): this can remove the tracked Local root while the
      // thread is checked out into a worktree (the row a later "Hand off to
      // Local" would return to). Deferred: either disable that row in the UI
      // with a visible reason ("This folder is where Hand off returns to") or
      // clear-and-warn on removal. See the BST-1390 Task 17 reviewer
      // addendum, item (b).
      void enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => ({
        checkoutLocalRootId: current.checkoutLocalRootId,
        ids: current.secondaryRootIds.filter((id) => id !== rootId),
        primaryRoot: current.primaryRoot,
        primaryRootId: current.primaryRootId,
        secondaryRoots: current.secondaryRoots.filter((root) => root.rootId !== rootId),
      })).catch((error: unknown) => {
        logger.error('Remove secondary failed', { error, rootId });
        toast({
          description: describeFailure(error),
          title: 'Remove folder failed',
          variant: 'destructive',
        });
      });
    },
    [enqueueThreadFoldersWrite, selectedMemoryThreadId]
  );

  // Resolved ONCE per hook instance, not per render — the capability check IS
  // the platform gate; web omits the affordance rather than stubbing it.
  const platform = useMemo(() => resolvePlatformBridge(), []);
  // The label travels WITH the handler (WorkspaceBarReveal): the chip must
  // never name an OS it cannot open, and `revealLabel()` is the same
  // platform-aware helper the file-explorer context actions use.
  const reveal = useMemo<WorkspaceBarReveal | undefined>(() => {
    if (!platform) {
      return;
    }
    return {
      label: revealLabel(),
      onReveal: (path: string): void => {
        platform.showItemInFolder(path).catch((error: unknown) => {
          logger.error('Reveal folder failed', { error, path });
        });
      },
    };
  }, [platform]);
  const onCopyPath = useCallback((path: string) => {
    copyWorkspaceBarValue(path, 'path');
  }, []);

  const primaryRootPath = primaryRoot?.path;
  const primaryAdapterRootId = usePrimaryAdapterRootId(rootDescriptors, primaryRootPath);
  const checkout = useThreadCheckoutStatus(
    primaryRootId && primaryRootPath
      ? {
          adapterRootId: primaryAdapterRootId,
          dbRootId: primaryRootId,
          path: primaryRootPath,
        }
      : null
  );
  const {
    checkout: worktreeCheckout,
    handOffToLocal: onHandOffToLocal,
    selectWorktree: onSelectWorktree,
  } = useThreadCheckout({
    enqueueThreadFoldersWrite,
    resolveRootIdForPath,
    selectedMemoryThreadId,
    threadMetadata: selectedThread?.metadata,
  });
  const { branchSwitcher, mode } = useWorkspaceBarMode({
    checkout,
    onHandOffToLocal,
    onSelectWorktree,
    primaryRootId,
    primaryRootPath,
    selectedMemoryThreadId,
    selectedThread,
    worktreeCheckout,
  });
  const forge = useWorkspaceBarForge({
    assistantThreadRepository,
    checkout,
    forgePrWatched,
    memoryResourceId,
    platform,
    primaryRootId: primaryRootId ?? null,
    selectedMemoryThreadId,
    updateThreadMetadata,
  });

  return {
    ...branchMenuEntry(primaryRoot, checkout, branchSwitcher),
    ...checkoutEntry(primaryRoot, checkout),
    ...forgeEntry(forge),
    ...modeEntry(mode),
    onAddFolder,
    ...(addRootDirectoryByPath ? { onAddRecent } : {}),
    onCopyPath,
    onMakePrimary,
    onRemoveSecondary,
    ...(primaryRoot ? { primaryRoot } : {}),
    recentRoots,
    ...(reveal ? { reveal } : {}),
    secondaryRoots,
  };
}
