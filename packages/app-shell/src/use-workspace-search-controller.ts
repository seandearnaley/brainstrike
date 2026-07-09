import {
  createGrepSearchService,
  createHybridSearchService,
  type DbHandle,
  type DrizzleFileChunkRepository,
  type ElectronFileChunkRepository,
  FileChunkRepository,
  type GrepSearchRepository,
  useFileChunkRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  buildLocalEmbeddingModelConfigMap,
  resolveEmbeddingSetModelInfo,
} from '@brainstrike/db-explorer/embedding-models';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useIdeFileEditor } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useSearchEmbedder } from '@brainstrike/vector-management';
import {
  type ResolvedFileInfo,
  useWorkspaceSearchStore,
  WorkspaceSearchExecutor,
  type WorkspaceSearchMode,
} from '@brainstrike/workspace-search';
import { useCallback, useMemo } from 'react';
import { useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('WorkspaceSearchController');

const EMPTY_DB_ROOT_IDS: readonly string[] = [];

export interface WorkspaceSearchController {
  onOpenFile: (compositeKey: string, line?: number) => void;
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runSemanticSearch: () => void;
  runTextSearch: () => void;
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

type PlatformChunkRepository = DrizzleFileChunkRepository | ElectronFileChunkRepository;

/**
 * Resolve the repository the grep service reads candidates from. The dependency
 * is structural (`GrepSearchRepository = { findGrepCandidates }`), so:
 *  - Desktop's ElectronFileChunkRepository implements `findGrepCandidates` against
 *    the real IPC db — prefer it so the platform repo's method is LIVE (not dead).
 *  - Web's DrizzleFileChunkRepository has no grep method, so fall back to the
 *    PGlite-direct FileChunkRepository. Its grep path (findGrepCandidates) touches
 *    ONLY `db.query`, which the DbHandle provides with a PGlite-compatible
 *    signature — so we pass a query-only view of the handle rather than asserting
 *    the handle is a whole PGlite client (the smallest honest seam).
 */
export function resolveGrepRepository(
  chunkRepository: PlatformChunkRepository,
  db: DbHandle
): GrepSearchRepository {
  if (typeof (chunkRepository as Partial<GrepSearchRepository>).findGrepCandidates === 'function') {
    return chunkRepository as GrepSearchRepository;
  }
  type FileChunkRepositoryCtorDb = ConstructorParameters<typeof FileChunkRepository>[0];
  const grepDb = { query: db.query.bind(db) } as unknown as FileChunkRepositoryCtorDb;
  return new FileChunkRepository(grepDb);
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
    const { query, isRegex, caseSensitive, wholeWord } = useWorkspaceSearchStore.getState();
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

/**
 * Composition-layer controller for the workspace-search panel: builds the
 * executor once from the live repositories, wires the run callbacks to the
 * store, and derives the query scope + open seam from the surrounding app
 * providers (root identity, IDE file editor).
 */
export function useWorkspaceSearchController(): WorkspaceSearchController {
  const db = usePGliteDatabase();
  const chunkRepository = useFileChunkRepository();
  const rootIdentity = useOptionalRootIdentity();
  const { openFileInTab } = useIdeFileEditor();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const { embedQueryWithRecovery } = useSearchEmbedder();
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
    // Prefer the platform chunk repo when it exposes findGrepCandidates (desktop's
    // ElectronFileChunkRepository — makes that method LIVE); web's Drizzle repo has
    // no grep method, so fall back to a query-only PGlite FileChunkRepository.
    const grepRepository = resolveGrepRepository(chunkRepository, db);
    return new WorkspaceSearchExecutor({
      embedQuery,
      grepService: createGrepSearchService(grepRepository),
      hybridService: createHybridSearchService(chunkRepository),
      resolveFiles: (ids) => resolveFilesFromDb(db, ids),
    });
  }, [db, chunkRepository, embedQuery]);

  const workspaceDbRootIds = rootIdentity?.workspaceDbRootIds ?? EMPTY_DB_ROOT_IDS;

  const runners = useMemo(() => {
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
  }, [executor, resolveEffectiveEmbeddingSetId, workspaceDbRootIds]);

  const resolveAdapterRootId = useCallback(
    (dbRootId: string): string | null => rootIdentity?.resolveAdapterRootId(dbRootId) ?? null,
    [rootIdentity]
  );

  const onOpenFile = useCallback(
    // The `line` target cannot be honored yet: `IdeFileEditorContext.openFileInTab`
    // accepts only the compositeKey (see packages/ui/src/layout/ide-layout.tsx).
    // Line-targeted open is a documented follow-up, not wired here.
    (compositeKey: string, _line?: number): void => {
      if (!openFileInTab) {
        logger.error('Workspace search selected a file but the file-open seam is unavailable', {
          compositeKey,
        });
        return;
      }
      // Match quick-open: surface the explorer route so the opened tab is visible.
      setActiveTab('explorer');
      openFileInTab(compositeKey);
    },
    [openFileInTab, setActiveTab]
  );

  return {
    onOpenFile,
    resolveAdapterRootId,
    runSemanticSearch: runners.runSemanticSearch,
    runTextSearch: runners.runTextSearch,
    workspaceDbRootIds,
  };
}
