import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import {
  BoundaryFailureError,
  describeBoundaryError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import type {
  IndexerSourceObservation,
  IndexerStatus,
  NativeIndexLifecycleObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { useIdeFileEditor } from '@brainstrike/ui';
import {
  getNativeSemanticAvailability,
  type NativePendingSearch,
  type NativeSemanticAvailability,
  NativeWorkspaceSearchExecutor,
  nativeSourceCompletion,
  noIndexedFolderRefusal,
  useNativeWorkspaceSearchDependencies,
  useWorkspaceSearchStore,
  type WorkspaceSearchMode,
} from '@brainstrike/workspace-search/core';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('WorkspaceSearchController');

const EMPTY_DB_ROOT_IDS: readonly string[] = [];
const NATIVE_INDEX_NOT_ATTACHED =
  'Workspace search is unavailable: the native index is not attached.';

export interface WorkspaceSearchController {
  allowTextPaging: boolean;
  onOpenFile: (
    compositeKey: string,
    target?: { line: number; selection?: { startLine: number; endLine: number } }
  ) => void;
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runSemanticSearch: () => void;
  runTextSearch: () => void;
  semanticAvailability: NativeSemanticAvailability;
  workspaceDbRootIds: readonly string[];
}

export function createNativeWorkspaceSearchRunners(
  executor: NativeWorkspaceSearchExecutor,
  rootIds: readonly string[],
  folderName: (rootId: string) => string,
  onTransitioning?: (generation: number, mode: WorkspaceSearchMode) => void,
  onIncompleteSource?: (
    generation: number,
    mode: WorkspaceSearchMode,
    source: NonNullable<
      Awaited<ReturnType<NativeWorkspaceSearchExecutor['searchText']>>
    >['incompleteSource'],
    query: string,
    after?: IndexerSourceObservation
  ) => void
): {
  runSemanticSearch: (after?: IndexerSourceObservation) => void;
  runTextSearch: (after?: IndexerSourceObservation) => void;
} {
  const run = (mode: WorkspaceSearchMode, after?: IndexerSourceObservation): void => {
    const store = useWorkspaceSearchStore.getState();
    const { query, caseSensitive, isRegex, wholeWord } = store;
    const generation = store.beginSearch();
    const request = { caseSensitive, folderName, isRegex, query, rootIds, wholeWord };
    void (mode === 'text' ? executor.searchText(request) : executor.searchSemantic(request))
      .then((results) => {
        if (results !== null) {
          useWorkspaceSearchStore.getState().resolveResults(results, generation);
          if (results.incompleteSource) {
            onIncompleteSource?.(generation, mode, results.incompleteSource, query, after);
          }
        }
      })
      .catch((error: unknown) => {
        if (
          onTransitioning &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'native-index-transitioning'
        ) {
          onTransitioning(generation, mode);
          return;
        }
        if (error instanceof BoundaryFailureError) {
          useWorkspaceSearchStore.getState().failSearch(describeBoundaryError(error), generation);
          return;
        }
        useWorkspaceSearchStore
          .getState()
          .failSearch(error instanceof Error ? error.message : String(error), generation);
      });
  };
  return {
    runSemanticSearch: (after) => run('semantic', after),
    runTextSearch: (after) => run('text', after),
  };
}

function pendingNativeOutcome(
  pending: NativePendingSearch,
  lifecycle: NativeIndexLifecycleObservation | null | undefined,
  status: IndexerStatus | undefined,
  rootIds: readonly string[]
): { readonly completion: IndexerSourceObservation | null; readonly error: string | null } | null {
  if (lifecycle?.kind === 'preparing') {
    return null;
  }
  const completion = pending.source
    ? nativeSourceCompletion(pending.source, status, rootIds)
    : null;
  if (
    pending.source
      ? !completion && lifecycle?.kind !== 'refused'
      : !lifecycle || lifecycle === pending.after
  ) {
    return null;
  }
  if (lifecycle?.kind !== 'refused') {
    return { completion, error: null };
  }
  const cause = lifecycle.cause;
  if (cause.kind === 'closed') {
    return { completion: null, error: cause.reason };
  }
  if (cause.kind === 'transitioning') {
    return { completion: null, error: 'Native index is transitioning.' };
  }
  return { completion: null, error: cause.message };
}

/**
 * Composition-layer controller for the workspace-search panel: builds the
 * native executor, wires the run callbacks to the store, and derives the query scope + open seam from the surrounding app
 * providers (root identity, IDE file editor).
 */
export function useWorkspaceSearchController(): WorkspaceSearchController {
  const nativeDependencies = useNativeWorkspaceSearchDependencies();
  const pendingSearch = useWorkspaceSearchStore((state) => state.nativePendingSearch);
  const lifecycle = nativeDependencies?.lifecycle;
  const [availabilityResult, setAvailabilityResult] = useState<{
    readonly scope: Parameters<typeof getNativeSemanticAvailability>[0];
    readonly value: NativeSemanticAvailability;
  } | null>(null);
  const refreshAvailability = useRef<(() => void) | null>(null);
  const rootIdentity = useOptionalRootIdentity();
  const { openFileInTab } = useIdeFileEditor();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  useEnsureModelRegistry();
  const workspaceDbRootIds = rootIdentity?.workspaceDbRootIds ?? EMPTY_DB_ROOT_IDS;
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const folderName = (dbRootId: string): string => {
    const adapterRootId = rootIdentity?.resolveAdapterRootId(dbRootId);
    return (adapterRootId ? rootDescriptors[adapterRootId]?.displayName : undefined) ?? dbRootId;
  };
  // The open folders the index serves; the others are named, never searched (BST-1988 opt-in).
  // The authorized set by content: every status poll is a new object, and a new
  // scope would send semantic availability back to "being verified".
  const nativeStatus = nativeDependencies?.status;
  const authorizedKey =
    nativeStatus?.kind === 'ready' ? JSON.stringify(nativeStatus.authorizedRootIds) : null;
  const indexedRootIds = useMemo((): readonly string[] => {
    if (authorizedKey === null) {
      return workspaceDbRootIds;
    }
    const authorized: readonly string[] = JSON.parse(authorizedKey);
    return workspaceDbRootIds.filter((rootId) => authorized.includes(rootId));
  }, [authorizedKey, workspaceDbRootIds]);
  const unindexedFolders = useMemo(
    () => workspaceDbRootIds.filter((rootId) => !indexedRootIds.includes(rootId)).map(folderName),
    [folderName, indexedRootIds, workspaceDbRootIds]
  );

  const nativeCapability = nativeDependencies?.capability ?? null;
  const nativeProfile = nativeDependencies?.profile ?? null;
  const nativeEmbedQuery = nativeDependencies === null ? null : nativeDependencies.embedQuery;
  const nativeProfileReason = nativeDependencies?.profileUnavailableReason;
  const nativeExecutor =
    nativeEmbedQuery === null
      ? null
      : new NativeWorkspaceSearchExecutor({
          capability: nativeCapability,
          embedQuery: nativeEmbedQuery,
          profile: nativeProfile,
          ...(nativeProfileReason === undefined
            ? {}
            : { profileUnavailableReason: nativeProfileReason }),
        });
  const retireSearchScope = useEffectEvent(() => {
    const store = useWorkspaceSearchStore.getState();
    const pending = pendingSearch?.generation === store.generation ? pendingSearch : null;
    if (store.status !== 'searching' && !pending) {
      return;
    }
    if (pending?.source) {
      store.consumeNativeSearch(pending);
      store.failSearch('Native workspace search scope or capability changed.', store.beginSearch());
      return;
    }
    const generation = store.beginSearch();
    if (lifecycle !== undefined && (pending || lifecycle?.kind === 'preparing')) {
      useWorkspaceSearchStore.getState().retainNativeSearch({
        after: pending ? pending.after : lifecycle,
        generation,
        mode: pending?.mode ?? store.mode,
      });
      return;
    }
    store.failSearch('Native workspace search scope or capability changed.', generation);
  });
  useEffect(() => {
    const releaseSearchScope = (): void => {
      if (nativeExecutor) {
        nativeExecutor.cancelPendingSearch();
        retireSearchScope();
      }
    };
    return releaseSearchScope;
  }, [nativeExecutor, workspaceDbRootIds]);
  useEffect(() => {
    const closeSearch = (): void => {
      const store = useWorkspaceSearchStore.getState();
      if (store.nativePendingSearch) {
        store.consumeNativeSearch(store.nativePendingSearch);
      }
      if (store.status === 'searching') {
        store.failSearch('Native workspace search was closed.', store.generation);
      }
    };
    return closeSearch;
  }, []);
  const availabilityScope =
    nativeEmbedQuery === null
      ? null
      : {
          capability: nativeCapability,
          profile: nativeProfile,
          ...(nativeProfileReason === undefined
            ? {}
            : { profileUnavailableReason: nativeProfileReason }),
          rootIds: indexedRootIds,
        };
  const nothingIndexed = indexedRootIds.length === 0 && unindexedFolders.length > 0;
  const semanticAvailability: NativeSemanticAvailability =
    availabilityResult?.scope === availabilityScope
      ? availabilityResult.value
      : { available: false, reason: 'Native vector availability is being verified.' };
  useEffect(() => {
    if (availabilityScope === null || nothingIndexed) {
      return;
    }
    let current = true;
    let pending = false;
    let refreshRequested = false;
    const refresh = async (): Promise<void> => {
      if (pending) {
        refreshRequested = true;
        return;
      }
      pending = true;
      do {
        refreshRequested = false;
        const value = await getNativeSemanticAvailability(availabilityScope).catch(
          (error: unknown) => ({
            available: false,
            reason: describeBoundaryError(error),
          })
        );
        if (!current) {
          return;
        }
        setAvailabilityResult({ scope: availabilityScope, value });
      } while (refreshRequested);
      pending = false;
    };
    refreshAvailability.current = () => {
      void refresh();
    };
    return () => {
      current = false;
      refreshAvailability.current = null;
    };
  }, [availabilityScope, nothingIndexed]);
  useEffect(() => {
    refreshAvailability.current?.();
  }, [availabilityScope, nativeDependencies]);

  const retainIncompleteSource = (
    generation: number,
    mode: WorkspaceSearchMode,
    source: NonNullable<
      Awaited<ReturnType<NativeWorkspaceSearchExecutor['searchText']>>
    >['incompleteSource'],
    query: string,
    after?: IndexerSourceObservation
  ): void => {
    const store = useWorkspaceSearchStore.getState();
    if (!source || store.generation !== generation || store.query !== query) {
      return;
    }
    useWorkspaceSearchStore.getState().retainNativeSearch({
      after: null,
      generation,
      mode,
      source: { ...source, query, ...(after ? { after } : {}) },
    });
  };

  const runners = useMemo(() => {
    if (nativeExecutor) {
      return createNativeWorkspaceSearchRunners(
        nativeExecutor,
        workspaceDbRootIds,
        folderName,
        lifecycle === undefined
          ? undefined
          : (generation, mode) => {
              if (useWorkspaceSearchStore.getState().generation === generation) {
                useWorkspaceSearchStore
                  .getState()
                  .retainNativeSearch({ after: lifecycle, generation, mode });
              }
            },
        retainIncompleteSource
      );
    }
    const unavailable = (): void => {
      const generation = useWorkspaceSearchStore.getState().beginSearch();
      useWorkspaceSearchStore.getState().failSearch(NATIVE_INDEX_NOT_ATTACHED, generation);
    };
    return { runSemanticSearch: unavailable, runTextSearch: unavailable };
  }, [folderName, lifecycle, nativeExecutor, retainIncompleteSource, workspaceDbRootIds]);

  useEffect(() => {
    if (!pendingSearch || lifecycle?.kind === 'preparing') {
      return;
    }
    const store = useWorkspaceSearchStore.getState();
    if (
      store.generation !== pendingSearch.generation ||
      !store.query.trim() ||
      (pendingSearch.source && store.query !== pendingSearch.source.query)
    ) {
      return;
    }
    const outcome = pendingNativeOutcome(
      pendingSearch,
      lifecycle,
      nativeDependencies?.status,
      indexedRootIds
    );
    if (!(outcome && store.consumeNativeSearch(pendingSearch))) {
      return;
    }
    if (outcome.error !== null) {
      store.failSearch(outcome.error, pendingSearch.generation);
      return;
    }
    if (pendingSearch.mode === 'text') {
      runners.runTextSearch(outcome.completion ?? undefined);
    } else {
      runners.runSemanticSearch(outcome.completion ?? undefined);
    }
  }, [indexedRootIds, lifecycle, nativeDependencies?.status, pendingSearch, runners]);

  const resolveAdapterRootId = (dbRootId: string): string | null =>
    rootIdentity?.resolveAdapterRootId(dbRootId) ?? null;

  const onOpenFile = (
    compositeKey: string,
    target?: { line: number; selection?: { startLine: number; endLine: number } }
  ): void => {
    if (!openFileInTab) {
      logger.error('Workspace search selected a file but the file-open seam is unavailable', {
        compositeKey,
      });
      return;
    }
    // Surface the explorer route so the opened tab is visible.
    setActiveTab('explorer');
    // Forward the target so the opened tab scrolls to it — and, for a chunk,
    // selects the block (the tab host's CodeSurface honors `line`/`selection`).
    // Omit the options object entirely when there is no target, and the
    // selection field when absent (exactOptionalPropertyTypes: no explicit
    // `undefined` members).
    if (!target) {
      openFileInTab(compositeKey, undefined);
      return;
    }
    openFileInTab(
      compositeKey,
      target.selection ? { line: target.line, selection: target.selection } : { line: target.line }
    );
  };

  return {
    allowTextPaging: false,
    onOpenFile,
    resolveAdapterRootId,
    runSemanticSearch: runners.runSemanticSearch,
    runTextSearch: runners.runTextSearch,
    semanticAvailability:
      nativeDependencies === null
        ? { available: false, reason: NATIVE_INDEX_NOT_ATTACHED }
        : nothingIndexed
          ? {
              available: false,
              reason: describeBoundaryError(noIndexedFolderRefusal(unindexedFolders)),
            }
          : semanticAvailability,
    workspaceDbRootIds,
  };
}
