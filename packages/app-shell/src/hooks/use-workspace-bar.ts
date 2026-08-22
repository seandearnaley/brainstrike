import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarProps,
  WorkspaceBarRecentRoot,
  WorkspaceBarRoot,
} from '@brainstrike/assistant-ui';
import { createClipboardService } from '@brainstrike/context-actions';
import type { DbHandle } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type { RecentRootEntry } from '@brainstrike/types';
import { useToast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { resolvePlatformBridge } from '../platform-bridge';
import { useAssistantThreadRootBinding } from './use-assistant-thread-root-binding';
import { useThreadCheckoutStatus } from './use-thread-checkout-status';

const logger = createLogger('WorkspaceBar');
// Same service `useCopyToClipboard` wraps, called directly: the bar needs the
// outcome (to surface a failure), not the hook's transient render state.
const clipboard = createClipboardService();

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

const EMPTY_SECONDARY_ROOT_IDS: readonly string[] = [];
// Shared empty results: `setState` with a fresh `[]` would defeat React's
// Object.is bail-out and re-render on every settle.
const NO_ROOTS: readonly WorkspaceBarRoot[] = [];
const NO_RECENT_ENTRIES: readonly RecentRootEntry[] = [];
// Root ids are uuidv7, so a space can never occur inside one — the joined key
// is a faithful VALUE identity for the id list.
const SECONDARY_ID_SEPARATOR = ' ';

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
 *   speak the DB space).
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
  const { toast } = useToast();
  const updateThreadMetadata = useAssistantThreadStore((state) => state.updateThreadMetadata);
  const threadsByResourceId = useAssistantThreadStore((state) => state.threadsByResourceId);
  const threadMetadataSecondaryRootIds = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((thread) => thread.id === selectedMemoryThreadId)
        ?.metadata?.secondaryRootIds
    : undefined;
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
  const { operatingRoot, threadRootBinding } = useAssistantThreadRootBinding({
    assistantThreadRepository,
    ...(currentMainRoot ? { currentMainRoot } : {}),
    database,
    memoryResourceId,
    selectedMemoryThreadId,
  });

  // Cancels an in-flight reconciliation wait on unmount or when the selected
  // thread changes: a folder added while thread A was open must never be
  // written onto thread B.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
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
  const warnedMainRootPathsRef = useRef(new Set<string>());
  useEffect(() => {
    if (bindingRootId || !(database && mainRootPath && mainRootDisplayName)) {
      setMainRootRow(null);
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
        if (!warnedMainRootPathsRef.current.has(mainRootPath)) {
          warnedMainRootPathsRef.current.add(mainRootPath);
          logger.warn(
            'the MAIN root has no unique live roots row; the workspace bar shows no primary',
            { error: lookup.error, path: mainRootPath }
          );
        }
        return;
      }
      setMainRootRow({ path: mainRootPath, rootId: lookup.rootId });
    });
    return () => {
      cancelled = true;
    };
  }, [bindingRootId, database, mainRootDisplayName, mainRootPath]);
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

  const [secondaryRoots, setSecondaryRoots] = useState<readonly WorkspaceBarRoot[]>(NO_ROOTS);
  useEffect(() => {
    if (!(database && secondaryRootIds.length > 0)) {
      setSecondaryRoots(NO_ROOTS);
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
        setSecondaryRoots(
          secondaryRootIds.flatMap((id) => {
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
          })
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to load the thread secondary roots', { error });
          setSecondaryRoots(NO_ROOTS);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, secondaryRootIds]);

  // The ledger is read once per capability identity; which entries are still
  // OFFERABLE is a render-time question (a folder mounted or disconnected this
  // session must leave/re-enter the list without another IPC round-trip).
  const [recentEntries, setRecentEntries] = useState<readonly RecentRootEntry[]>(NO_RECENT_ENTRIES);
  const listRecentRoots = fileSystem.listRecentRoots;
  useEffect(() => {
    if (!listRecentRoots) {
      setRecentEntries(NO_RECENT_ENTRIES);
      return;
    }
    let cancelled = false;
    listRecentRoots()
      .then((entries) => {
        if (!cancelled) {
          setRecentEntries(entries);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to list the recent roots', { error });
          setRecentEntries(NO_RECENT_ENTRIES);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [listRecentRoots]);
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
  const threadFoldersRef = useRef({ primaryRootId, secondaryRootIds });
  useEffect(() => {
    threadFoldersRef.current = { primaryRootId, secondaryRootIds };
  }, [primaryRootId, secondaryRootIds]);

  const recordAddedAsSecondary = useCallback(
    async (handle: { readonly name: string; readonly path: string }) => {
      if (!database) {
        throw new Error('Cannot record a thread folder before the workspace database is ready.');
      }
      const lookup = await resolveRootIdAfterReconciliation(
        database,
        { displayName: handle.name, path: handle.path },
        () => cancelledRef.current
      );
      if (lookup.kind === 'cancelled') {
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
      const current = threadFoldersRef.current;
      if (
        lookup.rootId === current.primaryRootId ||
        current.secondaryRootIds.includes(lookup.rootId)
      ) {
        return;
      }
      await writeThreadFolders([...current.secondaryRootIds, lookup.rootId]);
    },
    [database, toast, writeThreadFolders]
  );

  const addRootDirectory = fileSystem.addRootDirectory;
  const onAddFolder = useCallback(() => {
    addRootDirectory()
      .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
      .catch((error: unknown) => logger.error('Add folder failed', { error }));
  }, [addRootDirectory, recordAddedAsSecondary]);

  const addRootDirectoryByPath = fileSystem.addRootDirectoryByPath;
  const onAddRecent = useMemo(() => {
    if (!addRootDirectoryByPath) {
      return;
    }
    return (path: string): void => {
      addRootDirectoryByPath(path)
        .then((handle) => (handle ? recordAddedAsSecondary(handle) : undefined))
        .catch((error: unknown) =>
          logger.error('Recent folder could not be re-mounted', { error, path })
        );
    };
  }, [addRootDirectoryByPath, recordAddedAsSecondary]);

  const onMakePrimary = useCallback(
    (rootId: string) => {
      const next = secondaryRoots.find((root) => root.rootId === rootId);
      if (!next?.path) {
        logger.error('Make primary: unknown secondary root, or a root with no path', { rootId });
        return;
      }
      const demoted = primaryRootId && primaryRootId !== rootId ? [primaryRootId] : [];
      const remaining = secondaryRootIds.filter((id) => id !== rootId);
      // ONE metadata write: the thread binding keys and the secondary set move
      // together, so the store never shows an intermediate state with the new
      // primary still listed as a secondary. These are the same three
      // operatingRoot* keys persistThreadRootBinding writes (the sanitizer's
      // all-or-nothing rule), through the same store action — the global MAIN
      // root is deliberately untouched.
      writeThreadFolders([...remaining, ...demoted], {
        operatingRootDisplayName: next.displayName,
        operatingRootId: rootId,
        operatingRootPath: next.path,
      }).catch((error: unknown) => logger.error('Make primary failed', { error, rootId }));
    },
    [primaryRootId, secondaryRootIds, secondaryRoots, writeThreadFolders]
  );

  const onRemoveSecondary = useCallback(
    (rootId: string) => {
      writeThreadFolders(secondaryRootIds.filter((id) => id !== rootId)).catch((error: unknown) =>
        logger.error('Remove secondary failed', { error, rootId })
      );
    },
    [secondaryRootIds, writeThreadFolders]
  );

  // Resolved ONCE per hook instance, not per render — the capability check IS
  // the platform gate; web omits the affordance rather than stubbing it.
  const platform = useMemo(() => resolvePlatformBridge(), []);
  const onRevealRoot = useMemo(() => {
    if (!platform) {
      return;
    }
    return (path: string): void => {
      platform.showItemInFolder(path).catch((error: unknown) => {
        logger.error('Reveal folder failed', { error, path });
      });
    };
  }, [platform]);
  // Routed through the shared clipboard service (never raw navigator): a
  // present-but-broken Electron bridge is surfaced, not silently bypassed —
  // and its failure is rendered, not swallowed.
  const onCopyPath = useCallback(
    (path: string) => {
      clipboard
        .writeText(path)
        .then((outcome) => {
          if (outcome.ok) {
            return;
          }
          logger.error('Copy path failed', { error: outcome.error, path });
          toast({ description: outcome.error, title: 'Copy path failed', variant: 'destructive' });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('Copy path threw', { error: message, path });
          toast({ description: message, title: 'Copy path failed', variant: 'destructive' });
        });
    },
    [toast]
  );

  const checkout = useThreadCheckoutStatus(primaryRootId ?? null);

  return {
    ...(checkout ? { checkout } : {}),
    onAddFolder,
    ...(onAddRecent ? { onAddRecent } : {}),
    onCopyPath,
    onMakePrimary,
    onRemoveSecondary,
    ...(onRevealRoot ? { onRevealRoot } : {}),
    ...(primaryRoot ? { primaryRoot } : {}),
    recentRoots,
    secondaryRoots,
  };
}
