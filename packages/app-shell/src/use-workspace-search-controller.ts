import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { createGrepSearchService, createHybridSearchService } from '@brainstrike/db';
import { type DbHandle, useFileChunkRepository, usePGliteDatabase } from '@brainstrike/db/react';
import {
  buildLocalEmbeddingModelConfigMap,
  resolveEmbeddingSetModelInfo,
} from '@brainstrike/db-explorer/embedding-models';
import { createLogger } from '@brainstrike/logging';
import { useIdeFileEditor } from '@brainstrike/ui';
import { useSharedSearchEmbedder } from '@brainstrike/vector-management';
import {
  getNativeSemanticAvailability,
  type NativeSemanticAvailability,
  NativeWorkspaceSearchExecutor,
  type ResolvedFileInfo,
  useNativeWorkspaceSearchDependencies,
  useWorkspaceSearchStore,
  WorkspaceSearchExecutor,
  type WorkspaceSearchMode,
} from '@brainstrike/workspace-search/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('WorkspaceSearchController');

const EMPTY_DB_ROOT_IDS: readonly string[] = [];

export interface WorkspaceSearchController {
  allowTextPaging: boolean;
  onOpenFile: (
    compositeKey: string,
    target?: { line: number; selection?: { startLine: number; endLine: number } }
  ) => void;
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runSemanticSearch: () => void;
  runTextSearch: () => void;
  semanticAvailability: NativeSemanticAvailability | undefined;
  workspaceDbRootIds: readonly string[];
}

/**
 * Strictly parse the `embedding_sets.dimensions` value (mirrors
 * `use-semantic-search-executor.ts`): a missing/invalid dimension is a hard
 * error, never silently coerced.
 */
function parseStrictEmbeddingDimensions(value: unknown): number {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
    throw new Error('Embedding set dimensions are missing or invalid.');
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new Error('Embedding set dimensions are missing or invalid.');
}

interface FileRootInfoRow {
  displayName: string | null;
  id: string;
  path: string;
  rootId: string | null;
}

/**
 * Resolve fileRecordId → { path, dbRootId, rootDisplayName } for semantic-mode
 * grouping. A single JOIN to `roots` yields the display name inline — the
 * `FileRecord` model exposes neither `rootId` nor the root's display name, and
 * `findById` does not join `roots`, so a raw query is the honest way to produce
 * the executor's `ResolvedFileInfo` for both web (Drizzle) and desktop
 * (Electron) DB handles.
 */
async function resolveFilesFromDb(
  db: DbHandle,
  fileRecordIds: readonly string[]
): Promise<ReadonlyMap<string, ResolvedFileInfo>> {
  const uniqueIds = Array.from(new Set(fileRecordIds));
  const resolved = new Map<string, ResolvedFileInfo>();
  if (uniqueIds.length === 0) {
    return resolved;
  }
  const placeholders = uniqueIds.map((_, index) => `$${index + 1}`).join(', ');
  const result = await db.query<FileRootInfoRow>(
    `SELECT fr.id AS id, fr.path AS path, fr.root_id AS "rootId", r.display_name AS "displayName"
       FROM file_records fr
       LEFT JOIN roots r ON r.id = fr.root_id
      WHERE fr.id IN (${placeholders})`,
    [...uniqueIds]
  );
  for (const row of result.rows) {
    resolved.set(row.id, {
      dbRootId: row.rootId ?? null,
      path: row.path,
      rootDisplayName: row.displayName ?? null,
    });
  }
  return resolved;
}

interface WorkspaceSearchRunnerDeps {
  executor: Pick<WorkspaceSearchExecutor, 'searchSemantic' | 'searchText'>;
  resolveEffectiveEmbeddingSetId: () => Promise<string>;
  workspaceDbRootIds: readonly string[];
}

/**
 * Pure run-callback factory (host-independent, unit-testable): reads the live
 * store, resolves the effective embedding set, executes the mode-appropriate
 * search, and writes results/errors back. A `null` result means the request was
 * superseded by a newer one — a no-op (never clobbers the newer status).
 */
export function createWorkspaceSearchRunners(deps: WorkspaceSearchRunnerDeps): {
  runSemanticSearch: () => void;
  runTextSearch: () => void;
} {
  const run = (mode: WorkspaceSearchMode): void => {
    const { query, isRegex, caseSensitive, wholeWord, textResultLimit } =
      useWorkspaceSearchStore.getState();
    // Capture the run token so a superseded run's completion (results OR rejection)
    // is dropped by the store instead of clobbering a newer run's state.
    const generation = useWorkspaceSearchStore.getState().beginSearch();
    void (async () => {
      try {
        const embeddingSetId = await deps.resolveEffectiveEmbeddingSetId();
        const results =
          mode === 'text'
            ? await deps.executor.searchText({
                caseSensitive,
                embeddingSetId,
                isRegex,
                maxResults: textResultLimit,
                query,
                rootIds: deps.workspaceDbRootIds,
                wholeWord,
              })
            : await deps.executor.searchSemantic({
                embeddingSetId,
                query,
                rootIds: deps.workspaceDbRootIds,
              });
        if (results === null) {
          return;
        }
        useWorkspaceSearchStore.getState().resolveResults(results, generation);
      } catch (error) {
        useWorkspaceSearchStore
          .getState()
          .failSearch(error instanceof Error ? error.message : String(error), generation);
      }
    })();
  };

  return {
    runSemanticSearch: () => run('semantic'),
    runTextSearch: () => run('text'),
  };
}

export function createNativeWorkspaceSearchRunners(
  executor: NativeWorkspaceSearchExecutor,
  rootIds: readonly string[]
): { runSemanticSearch: () => void; runTextSearch: () => void } {
  const run = (mode: WorkspaceSearchMode): void => {
    const store = useWorkspaceSearchStore.getState();
    const { query, collectionId, caseSensitive, isRegex, wholeWord } = store;
    const generation = store.beginSearch();
    const request = { caseSensitive, collectionId, isRegex, query, rootIds, wholeWord };
    void (mode === 'text' ? executor.searchText(request) : executor.searchSemantic(request))
      .then((results) => {
        if (results !== null) {
          useWorkspaceSearchStore.getState().resolveResults(results, generation);
        }
      })
      .catch((error: unknown) => {
        useWorkspaceSearchStore
          .getState()
          .failSearch(error instanceof Error ? error.message : String(error), generation);
      });
  };
  return { runSemanticSearch: () => run('semantic'), runTextSearch: () => run('text') };
}

/**
 * Composition-layer controller for the workspace-search panel: builds the
 * executor once from the live repositories, wires the run callbacks to the
 * store, and derives the query scope + open seam from the surrounding app
 * providers (root identity, IDE file editor).
 */
export function useWorkspaceSearchController(): WorkspaceSearchController {
  const nativeDependencies = useNativeWorkspaceSearchDependencies();
  const selectedCollectionId = useWorkspaceSearchStore((state) => state.collectionId);
  const [availabilityResult, setAvailabilityResult] = useState<{
    readonly scope: Parameters<typeof getNativeSemanticAvailability>[0];
    readonly value: NativeSemanticAvailability;
  } | null>(null);
  const db = usePGliteDatabase();
  const chunkRepository = useFileChunkRepository();
  const rootIdentity = useOptionalRootIdentity();
  const { openFileInTab } = useIdeFileEditor();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  // Shared embedder cache (mounted by SearchEmbedderProvider in root-layout-content):
  // the workspace-search surface and the collection browser reuse ONE embedder.
  const { embedQueryWithRecovery } = useSharedSearchEmbedder();
  const models = useModelRegistryStore((state) => state.models);
  useEnsureModelRegistry({ db });

  const modelConfigMap = useMemo(() => buildLocalEmbeddingModelConfigMap(models), [models]);

  const embedQuery = useCallback(
    async (embeddingSetId: string, text: string): Promise<number[]> => {
      if (!db) {
        throw new Error('Database is not available to resolve the embedding set model.');
      }
      const res = await db.query<{ dimensions: number; modelKey: string }>(
        'SELECT model_key AS "modelKey", dimensions FROM embedding_sets WHERE id = $1 LIMIT 1',
        [embeddingSetId]
      );
      const row = res.rows[0];
      if (!row?.modelKey) {
        throw new Error('Embedding set is missing a model.');
      }
      const resolved = resolveEmbeddingSetModelInfo(
        { dimensions: parseStrictEmbeddingDimensions(row.dimensions), modelKey: row.modelKey },
        modelConfigMap
      );
      return embedQueryWithRecovery(
        {
          dimensions: resolved.dimensions,
          modelConfig: resolved.modelConfig ?? null,
          modelKey: resolved.modelKey,
        },
        text
      );
    },
    [db, modelConfigMap, embedQueryWithRecovery]
  );

  const resolveEffectiveEmbeddingSetId = useCallback(async (): Promise<string> => {
    const { collectionId } = useWorkspaceSearchStore.getState();
    if (collectionId) {
      return collectionId;
    }
    if (!db) {
      throw new Error('Database is not available to resolve the workspace index.');
    }
    const res = await db.query<{ id: string }>(
      "SELECT id FROM embedding_sets WHERE system_role = 'workspace-index' LIMIT 1"
    );
    const id = res.rows[0]?.id;
    if (!id) {
      throw new Error('No workspace index is available. Index a workspace before searching.');
    }
    return id;
  }, [db]);

  const executor = useMemo(() => {
    if (!(db && chunkRepository)) {
      return null;
    }
    // Both platform repos grep natively since BST-989 slice 2 (Electron over
    // the IPC db, Drizzle through its $client), so the repo passes straight
    // through — the old raw-repository web fallback is gone.
    return new WorkspaceSearchExecutor({
      embedQuery,
      grepService: createGrepSearchService(chunkRepository),
      hybridService: createHybridSearchService(chunkRepository),
      resolveFiles: (ids) => resolveFilesFromDb(db, ids),
    });
  }, [db, chunkRepository, embedQuery]);

  const workspaceDbRootIds = rootIdentity?.workspaceDbRootIds ?? EMPTY_DB_ROOT_IDS;

  const nativeCapability = nativeDependencies?.capability ?? null;
  const nativeProfile = nativeDependencies?.profile ?? null;
  const nativeEmbedQuery = nativeDependencies === null ? null : nativeDependencies.embedQuery;
  const nativeProfileReason = nativeDependencies?.profileUnavailableReason;
  const nativeExecutor = useMemo(
    () =>
      nativeEmbedQuery === null
        ? null
        : new NativeWorkspaceSearchExecutor({
            capability: nativeCapability,
            embedQuery: nativeEmbedQuery,
            profile: nativeProfile,
            ...(nativeProfileReason === undefined
              ? {}
              : { profileUnavailableReason: nativeProfileReason }),
          }),
    [nativeCapability, nativeProfile, nativeEmbedQuery, nativeProfileReason]
  );
  useEffect(
    () => () => {
      if (!nativeExecutor) {
        return;
      }
      nativeExecutor.cancelPendingSearch();
      const store = useWorkspaceSearchStore.getState();
      if (store.status === 'searching') {
        const generation = store.beginSearch();
        store.failSearch('Native workspace search scope or capability changed.', generation);
      }
    },
    [nativeExecutor, workspaceDbRootIds]
  );
  const availabilityScope = useMemo(
    () =>
      nativeDependencies === null
        ? null
        : {
            ...nativeDependencies,
            collectionId: selectedCollectionId,
            rootIds: workspaceDbRootIds,
          },
    [nativeDependencies, selectedCollectionId, workspaceDbRootIds]
  );
  const semanticAvailability: NativeSemanticAvailability =
    availabilityResult?.scope === availabilityScope
      ? availabilityResult.value
      : { available: false, reason: 'Native vector availability is being verified.' };
  useEffect(() => {
    if (availabilityScope === null) {
      return;
    }
    let current = true;
    void getNativeSemanticAvailability(availabilityScope).then((value) => {
      if (current) {
        setAvailabilityResult({ scope: availabilityScope, value });
      }
    });
    return () => {
      current = false;
    };
  }, [availabilityScope]);

  const runners = useMemo(() => {
    if (nativeExecutor) {
      return createNativeWorkspaceSearchRunners(nativeExecutor, workspaceDbRootIds);
    }
    if (!executor) {
      const unavailable = (): void => {
        const generation = useWorkspaceSearchStore.getState().beginSearch();
        useWorkspaceSearchStore
          .getState()
          .failSearch('Workspace search is unavailable: the database is not ready.', generation);
      };
      return { runSemanticSearch: unavailable, runTextSearch: unavailable };
    }
    return createWorkspaceSearchRunners({
      executor,
      resolveEffectiveEmbeddingSetId,
      workspaceDbRootIds,
    });
  }, [executor, nativeExecutor, resolveEffectiveEmbeddingSetId, workspaceDbRootIds]);

  const resolveAdapterRootId = useCallback(
    (dbRootId: string): string | null => rootIdentity?.resolveAdapterRootId(dbRootId) ?? null,
    [rootIdentity]
  );

  const onOpenFile = useCallback(
    (
      compositeKey: string,
      target?: { line: number; selection?: { startLine: number; endLine: number } }
    ): void => {
      if (!openFileInTab) {
        logger.error('Workspace search selected a file but the file-open seam is unavailable', {
          compositeKey,
        });
        return;
      }
      // Match quick-open: surface the explorer route so the opened tab is visible.
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
        target.selection
          ? { line: target.line, selection: target.selection }
          : { line: target.line }
      );
    },
    [openFileInTab, setActiveTab]
  );

  return {
    allowTextPaging: nativeDependencies === null,
    onOpenFile,
    resolveAdapterRootId,
    runSemanticSearch: runners.runSemanticSearch,
    runTextSearch: runners.runTextSearch,
    semanticAvailability: nativeDependencies === null ? undefined : semanticAvailability,
    workspaceDbRootIds,
  };
}
