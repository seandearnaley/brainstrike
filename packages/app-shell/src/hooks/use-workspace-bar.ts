import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type {
  WorkspaceBarProps,
  WorkspaceBarRecentRoot,
  WorkspaceBarRoot,
} from '@brainstrike/assistant-ui';
import type { DbHandle } from '@brainstrike/db/react';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type { RecentRootEntry } from '@brainstrike/types';
import { useCopyToClipboard } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AssistantOperatingRootCandidate,
  resolveAssistantOperatingRootBinding,
} from '../assistant-operating-root';
import { resolvePlatformBridge } from '../platform-bridge';
import { useAssistantThreadRootBinding } from './use-assistant-thread-root-binding';
import { useThreadCheckoutStatus } from './use-thread-checkout-status';

const logger = createLogger('WorkspaceBar');

interface WorkspaceBarRootDescriptor {
  readonly displayName: string;
  readonly path: string;
  readonly rootId: string;
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

/**
 * Everything the composer WorkspaceBar needs, from the THREAD's point of view.
 *
 * - PRIMARY = the thread's persisted operating-root binding, else the current
 *   MAIN root — shown at ANY root count (orientation, not disambiguation).
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
 * bar renders nothing rather than invented state.
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
  const threadMetadataSecondaryRootIds = selectedMemoryThreadId
    ? threadsByResourceId[memoryResourceId]?.find((thread) => thread.id === selectedMemoryThreadId)
        ?.metadata?.secondaryRootIds
    : undefined;
  const secondaryRootIds = threadMetadataSecondaryRootIds ?? EMPTY_SECONDARY_ROOT_IDS;
  const { operatingRoot, threadRootBinding } = useAssistantThreadRootBinding({
    assistantThreadRepository,
    ...(currentMainRoot ? { currentMainRoot } : {}),
    database,
    memoryResourceId,
    selectedMemoryThreadId,
  });

  // The primary's DURABLE id: the persisted binding's `roots.id`, else the MAIN
  // root's adapter rootId (the two id spaces coincide wherever reconcileRoots
  // established identity — they share only the path, so match on it).
  const primaryRootId =
    threadRootBinding?.rootId ??
    (currentMainRoot
      ? Object.values(rootDescriptors ?? {}).find(
          (descriptor) => descriptor.path === currentMainRoot.path
        )?.rootId
      : undefined);
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

  const recordAddedAsSecondary = useCallback(
    async (handle: { readonly name: string; readonly path: string }) => {
      if (!database) {
        throw new Error('Cannot record a thread folder before the workspace database is ready.');
      }
      const resolved = await resolveAssistantOperatingRootBinding(database, {
        displayName: handle.name,
        path: handle.path,
      });
      if (resolved.rootId === primaryRootId || secondaryRootIds.includes(resolved.rootId)) {
        return;
      }
      await writeThreadFolders([...secondaryRootIds, resolved.rootId]);
    },
    [database, primaryRootId, secondaryRootIds, writeThreadFolders]
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
  // present-but-broken Electron bridge is surfaced, not silently bypassed.
  const { copyToClipboard } = useCopyToClipboard();
  const onCopyPath = useCallback(
    (path: string) => {
      copyToClipboard(path);
    },
    [copyToClipboard]
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
