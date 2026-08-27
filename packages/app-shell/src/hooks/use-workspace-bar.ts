import type {
  AssistantThreadMetadata,
  AssistantThreadRepository,
} from '@brainstrike/assistant-data';
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
import { awaitRootRegistration, rootRegistrationSeq } from '../roots/root-registration-events';
import { useAssistantThreadRootBinding } from './use-assistant-thread-root-binding';
import { useThreadCheckout } from './use-thread-checkout';
import { useThreadCheckoutStatus } from './use-thread-checkout-status';
import type { ThreadCheckoutFolders, ThreadCheckoutWrite } from './use-thread-folders-write';
import {
  useDuplicatePathNotice,
  type WorkspaceBarRootDescriptor,
} from './use-workspace-bar-duplicate-path-notice';
import { useWorkspaceBarForge } from './use-workspace-bar-forge';
import { useWorkspaceBarMode } from './use-workspace-bar-mode';
import { useWorkspaceBarTerminal } from './use-workspace-bar-terminal';
import {
  deriveMakePrimary,
  folderWriteIdentityOf,
  MakePrimaryDerivationError,
  persistedCheckoutMode,
  type ResolvedSecondaryRoots,
  refuseWriteBeforeThreadMetadata,
  secondaryRootsStatus,
  type ThreadFoldersWriteTail,
  writeStartingPoint,
} from './use-workspace-bar-write-derive';
import { useWriteTailQueue } from './use-workspace-bar-write-tail-queue';
import { copyWorkspaceBarValue } from './workspace-bar-clipboard';

// Re-exported (not just imported) so existing test imports of
// `deriveMakePrimary` from this module keep working unchanged — the pure
// derive logic moved to `use-workspace-bar-write-derive.ts` purely to stay
// under Biome's file-line cap; this module's public surface did not change.
export { deriveMakePrimary };

const logger = createLogger('WorkspaceBar');

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
const HAND_OFF_RETURN_ROOT_REMOVE_REASON = 'This folder is where Hand off returns to.';

/**
 * A folder's durable `roots` row is written by the roots-reconciliation effect
 * in `workspace-collection-sync-provider.tsx`, which runs only AFTER
 * `addRootDirectory()` has resolved and re-rendered the provider. Looking the
 * row up in the same microtask therefore loses that race, and the folder mounts
 * globally while never being attached to the thread. Re-mounting a
 * `'disconnected'` root has the same shape (the row is flipped back to 'live'
 * by the same effect).
 *
 * So the lookup AWAITS the reconciliation layer's own "root registered"
 * notification (`../roots/root-registration-events.ts`) instead of polling
 * the database for the side effect — the canonical fix, landed in BST-1400
 * item 1. The seam is EPOCH-based, not a one-shot flag, so a path registered
 * a SECOND time this session (the remove-then-re-add shape above) still wakes
 * a waiter whose first read raced it — see that module's docblock. A bounded
 * timeout is still enforced (`ROOT_ROW_WAIT_TIMEOUT_MS`, the same ~5s budget
 * the old 20×250ms retry loop had): exhaustion is not a silent no-op for any
 * caller.
 */
const ROOT_ROW_WAIT_TIMEOUT_MS = 5000;

type RootRowLookup =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'resolved'; readonly rootId: string }
  | { readonly error: unknown; readonly kind: 'unresolved' };

type RootRowAttempt =
  | { readonly kind: 'miss'; readonly error: unknown }
  | { readonly kind: 'resolved'; readonly rootId: string };

/** One read of the durable `roots` row for `candidate.path`. Never throws. */
async function tryResolveRootId(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate
): Promise<RootRowAttempt> {
  try {
    const binding = await resolveAssistantOperatingRootBinding(database, candidate);
    return { kind: 'resolved', rootId: binding.rootId };
  } catch (error) {
    return { error, kind: 'miss' };
  }
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
 * BST-1400: `data-checkout-state` on the bar element (the deterministic e2e
 * wait that replaces sampling for the branch chip's absence). Pulled out for
 * the same reason as `checkoutEntry` above — a bare ternary inline in
 * `useWorkspaceBar`'s return statement was what tipped its cognitive
 * complexity over Biome's cap.
 */
function checkoutStateOf(checkoutSettled: boolean): 'pending' | 'resolved' {
  return checkoutSettled ? 'resolved' : 'pending';
}

/**
 * BST-1400 item 12: disables "Add folder…" and each Recent row for the same
 * reason `enqueueThreadFoldersWrite` already refuses the write —
 * `refuseWriteBeforeThreadMetadata` — but proactively instead of reactively.
 * Previously the OS picker (or a picker-less Recent re-mount) ran to
 * completion, the folder mounted GLOBALLY, and only THEN did the thread-level
 * write get refused — leaving a folder connected to the workspace but not to
 * the thread, with a "try again in a moment" toast as the only explanation.
 * Disabling the affordance while pending stops the picker from ever opening
 * for a write that cannot land yet. The reactive guard stays in place as a
 * backstop (e.g. a call this component didn't render the disabled state for
 * in time) — this only prevents the common, avoidable case.
 */
function addFolderDisabledReasonFor(selectedThreadMetadataPending: boolean): string | null {
  return selectedThreadMetadataPending ? "This thread hasn't finished loading yet" : null;
}

/**
 * Ready-to-spread partial, same shape as `checkoutEntry`/`forgeEntry`/
 * `modeEntry` above — pulled the conditional out of `useWorkspaceBar`'s
 * return statement entirely rather than an inline ternary spread, which
 * tipped that function's cognitive complexity over Biome's cap.
 */
function addFolderDisabledReasonEntry(addFolderDisabledReason: string | null): {
  readonly addFolderDisabledReason?: string;
} {
  return addFolderDisabledReason ? { addFolderDisabledReason } : {};
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
 * BST-1456: while checked out into a worktree, the secondary named by
 * `checkoutLocalRootId` is where a later hand-off returns to — its Remove
 * action must render disabled with a visible reason rather than let removal
 * silently strand that "return to". Pulled out (like `checkoutEntry` above)
 * so the hook's own cognitive-complexity budget stays untouched by this
 * decoration.
 */

/**
 * The thread's `checkoutLocalRootId` reads as meaningful ONLY while
 * `checkoutMode` is `'worktree'` — a stale value left over from a prior
 * worktree checkout must not leak into Local mode (S7). Pulled out for the
 * same reason as `decorateHandOffReturnRoot` above.
 */
function checkoutLocalRootIdFor(
  checkoutMode: 'local' | 'worktree',
  metadata: AssistantThreadMetadata | undefined
): string | undefined {
  return checkoutMode === 'worktree' ? metadata?.checkoutLocalRootId : undefined;
}

function decorateHandOffReturnRoot(
  loadedSecondaryRoots: readonly WorkspaceBarRoot[],
  checkoutMode: 'local' | 'worktree',
  checkoutLocalRootId: string | undefined
): readonly WorkspaceBarRoot[] {
  if (!(checkoutMode === 'worktree' && checkoutLocalRootId)) {
    return loadedSecondaryRoots;
  }
  return loadedSecondaryRoots.map((root) =>
    root.rootId === checkoutLocalRootId
      ? { ...root, removeDisabledReason: HAND_OFF_RETURN_ROOT_REMOVE_REASON }
      : root
  );
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
  useDuplicatePathNotice(rootDescriptors);
  return primaryAdapterRootId;
}

/**
 * The durable `roots.id` for a path, AWAITING reconciliation's own
 * registration event when the row is not there yet (instead of polling the
 * database for it — see the docblock above `ROOT_ROW_WAIT_TIMEOUT_MS`). Never
 * rejects: every outcome — including timeout — is returned so the caller can
 * surface it. Timeout is NOT a silent no-op for any caller.
 */
async function resolveRootIdAfterReconciliation(
  database: DbHandle,
  candidate: AssistantOperatingRootCandidate,
  isCancelled: () => boolean
): Promise<RootRowLookup> {
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  // Captured BEFORE the first read, not after: a registration for this exact
  // path can land concurrently with (or immediately after) that read — most
  // commonly a remove-then-re-add, since re-adding mints a fresh adapter id
  // and so is a genuine SECOND registration of the same path, not a no-op.
  // Comparing against the generation observed here (rather than asking "was
  // this path EVER registered?") is what makes a registration that beats the
  // first read still satisfy the wait below, instead of the wait resolving
  // instantly off a stale earlier registration while the row is still absent.
  const since = rootRegistrationSeq(candidate.path);
  const firstAttempt = await tryResolveRootId(database, candidate);
  if (firstAttempt.kind === 'resolved') {
    return { kind: 'resolved', rootId: firstAttempt.rootId };
  }
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  try {
    await awaitRootRegistration(candidate.path, { since, timeoutMs: ROOT_ROW_WAIT_TIMEOUT_MS });
  } catch (waitError) {
    // Timed out: reconciliation never announced this path. Loud, not silent —
    // the caller logs/toasts this outcome.
    return isCancelled() ? { kind: 'cancelled' } : { error: waitError, kind: 'unresolved' };
  }
  if (isCancelled()) {
    return { kind: 'cancelled' };
  }
  const secondAttempt = await tryResolveRootId(database, candidate);
  if (secondAttempt.kind === 'resolved') {
    return { kind: 'resolved', rootId: secondAttempt.rootId };
  }
  // Registration was announced but the row still fails the unique-live-row
  // read (e.g. a genuine duplicate path) — surface THAT error, not a stale one.
  return isCancelled() ? { kind: 'cancelled' } : { error: secondAttempt.error, kind: 'unresolved' };
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
 *   OPPORTUNISTIC — a row registered after this hook's own bounded wait
 *   (`ROOT_ROW_WAIT_TIMEOUT_MS`, via `../roots/root-registration-events.ts`)
 *   already gave up stays unseen until the next invalidation re-triggers the
 *   effect from scratch. That outer retrigger is a separate, still-open
 *   concern from the inner wait itself (BST-1400).
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
  const checkoutMode = selectedThread?.metadata?.checkoutMode ?? 'local';
  const checkoutLocalRootId = checkoutLocalRootIdFor(checkoutMode, selectedThread?.metadata);
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
  const loadedSecondaryRoots =
    database && resolvedSecondaries?.key === secondaryRootIdsKey
      ? resolvedSecondaries.roots
      : NO_ROOTS;
  // Display-only decoration (BST-1456): the hand-off return folder's Remove
  // action must be disabled with a visible reason while it is what a later
  // hand-off would return TO — the write-queue's own view of the secondary
  // list (`loadedSecondaryRoots`, below) stays undecorated, since a derive
  // reads `rootId`/`path`/`displayName`, never this UI-only field.
  const secondaryRoots = useMemo(
    () => decorateHandOffReturnRoot(loadedSecondaryRoots, checkoutMode, checkoutLocalRootId),
    [checkoutLocalRootId, checkoutMode, loadedSecondaryRoots]
  );
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

  // The ledger is read once per capability identity, and re-read after the
  // shared file-system source reports a flow that may have mutated Recents; which
  // entries are still OFFERABLE is a separate, render-time question (a folder
  // mounted or disconnected this session must leave/re-enter the list without
  // another IPC round-trip).
  const listRecentRoots = fileSystem.listRecentRoots;
  const recentRootsRevision = fileSystem.recentRootsRevision;
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
  const recentRequestGenerationRef = useRef(0);
  useEffect(() => {
    const generation = recentRequestGenerationRef.current + 1;
    recentRequestGenerationRef.current = generation;
    if (!listRecentRoots) {
      return;
    }
    void listRecentRoots()
      .then((entries) => {
        if (recentRequestGenerationRef.current === generation) {
          setLoadedRecents({ entries, source: listRecentRoots });
        }
      })
      .catch((error: unknown) => {
        if (recentRequestGenerationRef.current === generation) {
          logger.error('failed to list the recent roots', { error });
          setLoadedRecents({ entries: NO_RECENT_ENTRIES, source: listRecentRoots });
        }
      });
    return () => {
      recentRequestGenerationRef.current += 1;
    };
  }, [listRecentRoots, recentRootsRevision]);
  const mountedPaths = useMemo(
    () => new Set(Object.values(rootDescriptors ?? {}).map((descriptor) => descriptor.path)),
    [rootDescriptors]
  );
  const recentRoots = useMemo<readonly WorkspaceBarRecentRoot[]>(
    () =>
      // Exact-string, unlike main's platform-aware `pathsEqual` (case-folds on
      // macOS/Windows) — negligible here (BST-1400 item 9): both sides of this
      // comparison are produced by the SAME renderer, from the SAME adapter,
      // so `entry.path`/`descriptor.path` never disagree on casing the way a
      // user-typed or cross-process path could. Note only, not a bug to fix.
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
   * - once the queue drains AND `threadFoldersRef` has moved past what it
   *   was when the last write started, the tail retires so the next write
   *   reads LIVE state rather than a stale value from an already-settled
   *   round of writes (metadata changed by another surface must not be
   *   reverted). A hand-off between overlapping writes, never a cache.
   *
   *   Retiring the moment the queue drains, WITHOUT waiting for the ref,
   *   raced React's commit (item 2 v1): the ref resyncs via an effect on a
   *   LATER tick than the write's own settle microtask, so a second write
   *   landing in that window derived from a ref missing the first write's
   *   change. Retiring only once the ref matched the write's OWN result
   *   (item 2 v1's fix) traded that for a rarer bug (v2, review fold-in): it
   *   could not tell "hasn't caught up yet" from "caught up to something
   *   ELSE" — a third-party change compared unequal to the tail forever,
   *   PINNING it, reverting the third-party change on the next write.
   *   `useWriteTailQueue`'s identity-REVISION counter fixes this the way
   *   item 1 fixed the same "did X happen after Y" shape: an epoch, not a
   *   membership/equality check — retire once the identity has moved AT ALL
   *   since the write started, to its own result or to anything else.
   *
   * A write whose thread is no longer selected — or that outlives the hook —
   * is skipped rather than landed on whatever thread is current now.
   */
  const {
    currentRevision: currentLiveIdentityRevision,
    pendingWriteCountRef,
    recordLiveIdentity,
    retireWriteTailIfCaughtUp,
    settleWrite,
    writeTailRef,
  } = useWriteTailQueue();

  // The reconciliation wait below can span seconds, so the folder set captured
  // when the user clicked may be stale by the time the write happens (a removal
  // in between would be undone). Read the CURRENT set through this ref instead.
  // It carries the thread it describes, so a queued write can prove it is still
  // deriving from the thread it was started for.
  const threadFoldersRef = useRef<ThreadCheckoutFolders>({
    checkoutLocalRootId,
    checkoutMode,
    metadataPending: selectedThreadMetadataPending,
    primaryRoot,
    primaryRootId,
    secondaryRootIds,
    secondaryRoots: loadedSecondaryRoots,
    secondaryRootsError,
    secondaryRootsPending,
    threadId: selectedMemoryThreadId,
  });
  useEffect(() => {
    const live: ThreadCheckoutFolders = {
      checkoutLocalRootId,
      checkoutMode,
      metadataPending: selectedThreadMetadataPending,
      primaryRoot,
      primaryRootId,
      secondaryRootIds,
      secondaryRoots: loadedSecondaryRoots,
      secondaryRootsError,
      secondaryRootsPending,
      threadId: selectedMemoryThreadId,
    };
    threadFoldersRef.current = live;
    // The other half of the write-queue's tail retirement (BST-1400 item 2):
    // a write settling does not mean this ref has caught up to it yet — see
    // the `writeTailRef` doc comment above. This effect is the render
    // committing that catch-up, so a genuine identity change bumps the
    // revision here (not only at settle time), and every sync re-checks
    // whether that is now enough to retire.
    recordLiveIdentity(folderWriteIdentityOf(live));
    retireWriteTailIfCaughtUp();
  }, [
    checkoutLocalRootId,
    checkoutMode,
    primaryRoot,
    primaryRootId,
    secondaryRootIds,
    loadedSecondaryRoots,
    secondaryRootsError,
    secondaryRootsPending,
    selectedMemoryThreadId,
    selectedThreadMetadataPending,
    recordLiveIdentity,
    retireWriteTailIfCaughtUp,
  ]);

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
      // Captured the instant `live` is actually read below (after awaiting
      // `previous`, since the identity can move DURING that wait) — the bar
      // this write's own settle must clear before its tail may retire.
      let revisionAtStart = currentLiveIdentityRevision();
      const settled = (async (): Promise<ThreadFoldersWriteTail | null> => {
        const tail = previous ? await previous : null;
        const live = threadFoldersRef.current;
        revisionAtStart = currentLiveIdentityRevision();
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
        const current = writeStartingPoint(live, tail, startedForThreadId);
        const request = derive(current);
        if (!request) {
          return tail;
        }
        await writeThreadFolders(request.ids, request.binding);
        return {
          checkoutLocalRootId: request.checkoutLocalRootId,
          checkoutMode: persistedCheckoutMode(current, request),
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
      // This write is the most recent to settle, so ITS start-revision
      // (a `then` chain settles in enqueue order) is the fresh retirement
      // bar; `settleWrite` retires immediately if threadFoldersRef already
      // moved past it, otherwise the sync effect retires it once it does.
      void tailed.then(() => settleWrite(revisionAtStart));
      return settled.then(() => undefined);
    },
    [
      currentLiveIdentityRevision,
      pendingWriteCountRef,
      settleWrite,
      writeTailRef,
      writeThreadFolders,
    ]
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
    [database, enqueueThreadFoldersWrite, selectedMemoryThreadId]
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
      // root is deliberately untouched. `deriveMakePrimary` folds the
      // worktree-to-Local switch (BST-1456) into this SAME write when it
      // applies, rather than leaving checkoutMode stuck at 'worktree' with no
      // worktree behind it (see its docblock).
      let localTransitionPrimaryName: string | null = null;
      void enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
        try {
          const request = deriveMakePrimary(current, rootId);
          if (request.binding?.['checkoutMode'] === 'local') {
            localTransitionPrimaryName = request.primaryRoot?.displayName ?? null;
          }
          return request;
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
      })
        .then(() => {
          if (localTransitionPrimaryName) {
            toast({
              description: `“${localTransitionPrimaryName}” is primary. The former worktree is no longer attached to this thread.`,
              title: 'Thread is Local again',
            });
          }
        })
        .catch((error: unknown) => {
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
      // BST-1456: the UI disables this row (with a visible reason) while it is
      // the hand-off return folder — this is the backstop for a call that
      // bypasses that disable, so removal never silently strands a "return to"
      // that no longer exists.
      void enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
        if (current.checkoutMode === 'worktree' && current.checkoutLocalRootId === rootId) {
          throw new Error(HAND_OFF_RETURN_ROOT_REMOVE_REASON);
        }
        return {
          checkoutLocalRootId: current.checkoutLocalRootId,
          ids: current.secondaryRootIds.filter((id) => id !== rootId),
          primaryRoot: current.primaryRoot,
          primaryRootId: current.primaryRootId,
          secondaryRoots: current.secondaryRoots.filter((root) => root.rootId !== rootId),
        };
      }).catch((error: unknown) => {
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
  const workspaceBarTerminal = useWorkspaceBarTerminal();

  const primaryRootPath = primaryRoot?.path;
  const primaryAdapterRootId = usePrimaryAdapterRootId(rootDescriptors, primaryRootPath);
  const { checkout, settled: checkoutSettled } = useThreadCheckoutStatus(
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
  const addFolderDisabledReason = addFolderDisabledReasonFor(selectedThreadMetadataPending);

  return {
    ...branchMenuEntry(primaryRoot, checkout, branchSwitcher),
    // BST-1400: the deterministic e2e wait `data-checkout-state` on the bar
    // exposes, replacing a bounded-sampling loop over "no branch chip yet".
    checkoutState: checkoutStateOf(checkoutSettled),
    ...checkoutEntry(primaryRoot, checkout),
    ...forgeEntry(forge),
    ...modeEntry(mode),
    ...workspaceBarTerminal,
    ...addFolderDisabledReasonEntry(addFolderDisabledReason),
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
