import {
  type EmbeddingSet,
  refreshCollectionIndexingStats,
  useClearAllData,
  useDbProviderError,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  getRegisteredEmbeddingQueueFactory,
  registerEmbeddingQueueFactory,
  resetEmbeddingQueueFactory,
} from '@brainstrike/embeddings/runtime-config';
import { useLocalRuntimeEmbeddingModelCatalog } from '@brainstrike/preferences/hooks/use-local-runtime-embedding-model-catalog';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import {
  type CachedCollection,
  useVectorStatusUIStore,
} from '@brainstrike/preferences/stores/vector-status-ui-store';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import {
  CreateEmbeddingSetDialog,
  DeleteEmbeddingSetDialog,
  EmbeddingActionsDropdown,
  RenameEmbeddingSetDialog,
  useEmbeddingControls,
} from '@brainstrike/vector-management';
import { Database, FileText, HelpCircle, Pencil, Plus, RefreshCw, Settings2 } from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ClearDatabaseDialog } from './components/clear-database-dialog';
import { CollectionBrowserView } from './components/collection-browser-view';
import { ExportDropdown } from './components/export-dropdown';
import { ImportProgressBar } from './components/import-progress-bar';
import { SearchCollectionSelector } from './components/search-collection-selector';
import { SettingsPanel } from './components/settings-panel';
import { SemanticSearchProvider, useSemanticSearch } from './contexts/semantic-search-context';
import { useAvailableModels, useAvailableProviders } from './hooks/use-available-models';
import { useCollectionDialogs } from './hooks/use-collection-dialogs';
import { useDatabaseErrorBoundary } from './hooks/use-database-error-boundary';
import { useExportHandlers } from './hooks/use-export-handlers';
import { createImportCompletionHandler } from './hooks/use-import-completion';
import { useImportSettings } from './hooks/use-import-settings';
import { useSemanticSearchExecutor } from './hooks/use-semantic-search-executor';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import { useDatabaseDemoData } from './use-database-demo-data';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
}

interface CreateCollectionDialogProps {
  db: ReturnType<typeof usePGliteDatabase>;
  onClose: () => void;
  onCreated: (newSetId: string, newSet: EmbeddingSet) => void;
  repository: ReturnType<typeof useEmbeddingSetsRepository>;
}

function CreateCollectionDialog({
  db,
  onClose,
  onCreated,
  repository,
}: CreateCollectionDialogProps): ReactElement {
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const isRegistryLoading = useModelRegistryStore((state) => state.isLoading);
  useEnsureModelRegistry({ db });
  const { catalog: runtimeEmbeddingCatalog, isLoading: isRuntimeCatalogLoading } =
    useLocalRuntimeEmbeddingModelCatalog({
      maxVerificationModels: 8,
      verifyEmbeddingDimensions: true,
    });
  const availableModels = useAvailableModels(models, runtimeEmbeddingCatalog);
  const availableProviders = useAvailableProviders(providers, runtimeEmbeddingCatalog);

  return (
    <CreateEmbeddingSetDialog
      isLoading={isRegistryLoading || isRuntimeCatalogLoading}
      models={availableModels}
      onOpenChange={(open: boolean) => {
        if (!open) {
          onClose();
        }
      }}
      onSetCreated={onCreated}
      open
      providers={availableProviders}
      repository={repository}
    />
  );
}

function DatabasePanelFrame({
  busy,
  children,
}: {
  busy: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      aria-busy={busy}
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel-surface [contain:layout_paint_style]"
      data-testid="database-demo-panel"
    >
      {children}
    </div>
  );
}

function DatabasePanelStateContent({ error }: { error?: Error }): ReactElement {
  const failed = Boolean(error);
  return (
    <>
      <div className="flex min-h-0 flex-[38] flex-col" data-testid="database-panel-loading-top">
        <div
          className="@container/database-toolbar h-12 shrink-0 border-b bg-background"
          data-testid="database-panel-toolbar"
        >
          <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
              <Database className="size-4 shrink-0" />
              <span className="@[360px]:inline hidden" data-testid="database-panel-loading-label">
                {failed ? 'Database unavailable' : 'Database'}
              </span>
            </div>
            <div aria-hidden="true" className="flex @[360px]:gap-2 gap-1">
              <div className="size-7 rounded-md bg-muted/55" />
              <div className="size-7 rounded-md bg-muted/55" />
              <div
                className="h-7 @[360px]:w-20 w-7 rounded-md bg-muted/55"
                data-testid="database-panel-loading-settings"
              />
            </div>
          </div>
        </div>
        <div
          className="flex min-h-0 flex-1 items-center justify-center px-4 py-3"
          data-testid="database-panel-loading-body"
        >
          <div
            className={
              failed ? 'max-w-md text-destructive text-xs' : 'text-muted-foreground text-xs'
            }
            role={failed ? 'alert' : 'status'}
          >
            {failed ? (
              <>
                <div className="font-medium">Database failed to initialize</div>
                <div className="mt-1 break-all" data-testid="db-init-error">
                  {error ? String(error.message || error) : ''}
                </div>
                <div className="mt-1 text-muted-foreground">
                  Ensure pgvector is available in Electron and try restarting the app.
                </div>
              </>
            ) : (
              'Loading PGlite database…'
            )}
          </div>
        </div>
        <div
          aria-hidden="true"
          className="flex h-12 shrink-0 items-center justify-center gap-2 border-t bg-background px-2"
          data-testid="database-panel-loading-actions"
        >
          <div className="h-8 w-10 rounded-md bg-muted/50" />
          <div className="size-8 rounded-md bg-muted/50" />
          <div className="h-8 w-14 rounded-md bg-muted/50" />
        </div>
      </div>
      <div aria-hidden="true" className="h-1 shrink-0 bg-border" />
      <div aria-hidden="true" className="min-h-0 flex-[62] border-t bg-background/35 p-4">
        <div className="h-full rounded-md border border-border/60 bg-muted/15" />
      </div>
    </>
  );
}

function collectionCacheSnapshotFromEmbeddingSet(set: EmbeddingSet): CachedCollection {
  return {
    category: set.category ?? null,
    chunkCount: 0,
    createdAt: set.createdAt,
    description: set.description ?? null,
    dimensions: set.dimensions,
    distance: set.distance,
    embeddingCount: 0,
    fileCount: 0,
    id: set.id,
    modelId: set.modelId,
    modelKey: set.modelKey,
    name: set.name ?? null,
    tags: set.tags ?? null,
  };
}

interface DatabaseDemoImportTestSnapshot {
  activeCollectionId: string | null;
  isImporting: boolean;
  progress: {
    completed: number;
    current: string;
    errors: Array<{ error: string; file: string }>;
    phase: EnhancedImportProgress['phase'];
    total: number;
  } | null;
  selectedFileCount: number;
}

interface DatabaseDemoSemanticSearchTestSnapshot {
  error: string | null;
  firstResultNodeId: string | null;
  hasSearched: boolean;
  isSearching: boolean;
  resultCount: number;
}

declare global {
  interface Window {
    __brainstrikeDatabaseDemoSemanticSearchTestHooks__?:
      | {
          getSnapshot: () => DatabaseDemoSemanticSearchTestSnapshot;
        }
      | undefined;
    __brainstrikeDatabaseDemoTestHooks__?:
      | {
          getImportSnapshot: () => DatabaseDemoImportTestSnapshot;
        }
      | undefined;
    desktopLifecycle?:
      | {
          isTestMode?: boolean;
        }
      | undefined;
  }
}

const logger = createLogger('DatabaseDemoPanel');

function DatabaseDemoSemanticSearchTestHookBridge() {
  const { error, hasSearched, isSearching, searchResults } = useSemanticSearch();

  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__ = {
      getSnapshot: () => ({
        error,
        firstResultNodeId: searchResults[0]?.nodeId ?? null,
        hasSearched,
        isSearching,
        resultCount: searchResults.length,
      }),
    };

    return () => {
      window.__brainstrikeDatabaseDemoSemanticSearchTestHooks__ = undefined;
    };
  }, [error, hasSearched, isSearching, searchResults]);

  return null;
}

// Factory reset is now provided via the shared Preferences UI (FactoryResetPanel).
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Legacy component with complex UI state - refactor tracked separately
export function DatabaseDemoPanel({ embeddingQueue = null }: DatabaseDemoPanelProps = {}) {
  const repository = useFileRecordRepository();
  const dbChunkRepository = useFileChunkRepository();
  const dbInitError = useDbProviderError();
  const clearAllData = useClearAllData();
  const dbContext = usePGliteDatabase();

  const { toast } = useToast();
  const errorBoundary = useDatabaseErrorBoundary({
    onError: (error) => {
      logger.error('Database operation error', { error });
    },
    toast,
  });

  const [clearing, setClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);

  // Collection dialog management (create, rename, delete)
  const collectionDialogs = useCollectionDialogs();

  // Use Zustand store directly as single source of truth for collection selection and import state
  const activeCollectionId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const activeCollectionName = useVectorStatusUIStore((state) => {
    const collection = state.cachedCollections.find(
      (candidate) => candidate.id === activeCollectionId
    );
    return collection?.name ?? collection?.modelKey ?? undefined;
  });
  const activeCollectionSystemRole = useVectorStatusUIStore((state) => {
    const collection = state.cachedCollections.find(
      (candidate) => candidate.id === activeCollectionId
    );
    return collection?.systemRole ?? null;
  });
  const setActiveCollectionId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);
  const upsertCachedCollection = useVectorStatusUIStore((s) => s.upsertCachedCollection);
  const setIsImporting = useVectorStatusUIStore((s) => s.setIsImporting);
  const managedCollectionId = useBackgroundIndexingPreferencesStore((s) => s.managedCollectionId);
  const isManagedCollection = Boolean(
    activeCollectionId &&
      (activeCollectionSystemRole === 'workspace-index' ||
        activeCollectionId === managedCollectionId)
  );

  // Get embedding sets repository from DbProvider (Drizzle-based)
  const embeddingSetsRepository = useEmbeddingSetsRepository();

  const showSettings = useDatabaseDemoStore((s) => s.showSettings);
  const recordPage = useDatabaseDemoStore((s) => s.recordPage);
  const recordPageSize = useDatabaseDemoStore((s) => s.recordPageSize);
  const resetRecordPagination = useDatabaseDemoStore((s) => s.resetRecordPagination);
  const setRecordPage = useDatabaseDemoStore((s) => s.setRecordPage);
  const setRecordPageSize = useDatabaseDemoStore((s) => s.setRecordPageSize);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);

  const importSettings = useImportSettings();
  const [chunkRepository, setChunkRepository] =
    useState<UseImportFlowResult['chunkRepository']>(null);
  const resolveActiveCollectionId = useCallback(() => activeCollectionId, [activeCollectionId]);

  // Read import state from Zustand store (shared with VectorStatus for query pausing)
  const isImportActive = useVectorStatusUIStore((s) => s.isImporting);
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);

  const data = useDatabaseDemoData({
    activeCollectionId,
    chunkRepository,
    database: dbContext,
    isEmbeddingActive,
    isImporting: isImportActive,
    recordPage,
    recordPageSize,
    repository,
    toast,
  });
  const {
    collectionCounts,
    collectionCountsStatus,
    records,
    chunks,
    initialLoading,
    refreshing,
    loadRecords,
    loadChunks,
    loadChunkDetail,
    loadFileChunkSummaries,
    loadCollectionExportData,
    recordPagination,
  } = data;
  const activeCollectionCounts = collectionCounts;
  const activeCollectionCountsPending = collectionCountsStatus === 'pending';
  const previousCollectionIdRef = useRef<string | null>(activeCollectionId);

  useEffect(() => {
    if (previousCollectionIdRef.current === activeCollectionId) {
      return;
    }
    previousCollectionIdRef.current = activeCollectionId;
    resetRecordPagination();
  }, [activeCollectionId, resetRecordPagination]);

  // biome-ignore lint/plugin: Persisted pagination must clamp after collection totals change.
  useEffect(() => {
    const maxPage = Math.max(0, recordPagination.totalPages - 1);
    if (recordPage > maxPage) {
      setRecordPage(maxPage);
    }
  }, [recordPage, recordPagination.totalPages, setRecordPage]);

  const exportHandlers = useExportHandlers(loadCollectionExportData, toast);

  // Create semantic search executor for the collection browser
  // Use dbChunkRepository (from hook) which is always available when DB is ready,
  // rather than chunkRepository (from import flow) which requires import to be triggered
  const semanticSearchExecutor = useSemanticSearchExecutor({
    chunkRepository: dbChunkRepository,
    fileRepository: repository,
  });

  // Embedding controls state for the action dropdown. Canonical queue/activity
  // status is rendered by the shared app-shell status bar.
  const { dropdownProps } = useEmbeddingControls({
    chunkRepository: dbChunkRepository,
    toast,
  });

  const importFlowSettings = useMemo(
    () => ({
      chunkingStrategy: importSettings.chunkingStrategy,
      chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
      chunkOverlap: importSettings.chunkOverlap,
      chunkSize: importSettings.chunkSize,
      chunkTokenLimit: importSettings.chunkTokenLimit,
      enableChunking: importSettings.enableChunking,
      tokenTrueSizing: importSettings.tokenTrueSizing,
    }),
    [
      importSettings.enableChunking,
      importSettings.chunkingStrategy,
      importSettings.chunkingStrategyExplicit,
      importSettings.chunkSize,
      importSettings.chunkOverlap,
      importSettings.tokenTrueSizing,
      importSettings.chunkTokenLimit,
    ]
  );

  const handleImportComplete = useCallback(
    async (results: EnhancedImportResult[]) => {
      const handler = createImportCompletionHandler(toast, loadRecords, loadChunks, async () => {
        if (!dbContext) {
          throw new Error('Import completion stats refresh requires an initialized database.');
        }
        if (!activeCollectionId) {
          throw new Error('Import completion stats refresh requires an active collection.');
        }
        await refreshCollectionIndexingStats(dbContext, [activeCollectionId], {
          label: 'import completion stats refresh',
          priority: 'foreground',
        });
      });
      await handler(results);
    },
    [activeCollectionId, dbContext, toast, loadRecords, loadChunks]
  );

  const importFlow = useImportFlow({
    embeddingQueue,
    importSettings: importFlowSettings,
    onChunkRepositoryChange: setChunkRepository,
    onImportComplete: handleImportComplete,
    resolveActiveCollectionId,
    toast,
  });

  // Sync import state to Zustand store to pause live queries during bulk operations
  // This prevents O(n²) performance degradation from live queries firing on every DB mutation
  // The store is also read by VectorStatus to pause its queue monitoring queries
  useEffect(() => {
    setIsImporting(importFlow.isImporting);
  }, [importFlow.isImporting, setIsImporting]);

  useEffect(() => {
    if (!embeddingQueue) {
      return;
    }

    const queueFactory = () => embeddingQueue;
    registerEmbeddingQueueFactory(queueFactory);

    return () => {
      if (getRegisteredEmbeddingQueueFactory() === queueFactory) {
        resetEmbeddingQueueFactory();
      }
    };
  }, [embeddingQueue]);

  useEffect(() => {
    if (!window.desktopLifecycle?.isTestMode) {
      return;
    }

    window.__brainstrikeDatabaseDemoTestHooks__ = {
      getImportSnapshot: () => ({
        activeCollectionId,
        isImporting: importFlow.isImporting,
        progress: importFlow.progress
          ? {
              chunkingProgress: importFlow.progress.chunkingProgress
                ? {
                    chunksCreated: importFlow.progress.chunkingProgress.chunksCreated,
                    currentFile: importFlow.progress.chunkingProgress.currentFile ?? '',
                    filesProcessed: importFlow.progress.chunkingProgress.filesProcessed,
                    strategyUsed: importFlow.progress.chunkingProgress.strategyUsed ?? '',
                    totalFiles: importFlow.progress.chunkingProgress.totalFiles,
                  }
                : null,
              completed: importFlow.progress.completed,
              current: importFlow.progress.current ?? '',
              errors: importFlow.progress.errors.map((entry) => ({
                error: entry.error,
                file: entry.file,
              })),
              phase: importFlow.progress.phase,
              total: importFlow.progress.total,
            }
          : null,
        recordCount: records.length,
        recordPagination: {
          currentPage: recordPagination.currentPage,
          pageSize: recordPagination.pageSize,
          totalRecords: recordPagination.totalRecords,
        },
        selectedFileCount: importFlow.selectedFileCount,
      }),
    };

    return () => {
      window.__brainstrikeDatabaseDemoTestHooks__ = undefined;
    };
  }, [
    activeCollectionId,
    importFlow.isImporting,
    importFlow.progress,
    importFlow.selectedFileCount,
    recordPagination.currentPage,
    recordPagination.pageSize,
    recordPagination.totalRecords,
    records.length,
  ]);

  const handleClearDatabase = useCallback(async () => {
    if (!clearAllData) {
      toast({
        description: 'Database clear functionality is not ready.',
        title: 'Clear Function Not Available',
        variant: 'destructive',
      });
      return;
    }

    setShowClearDialog(false);

    await errorBoundary.executeMultipleOperations(
      [
        {
          critical: true,
          name: 'Clear Database',
          operation: async () => clearAllData(),
        },
        {
          critical: false,
          name: 'Reload File Records',
          operation: async () => {
            await loadRecords();
            return { deletedChunks: 0, deletedFiles: 0 };
          },
        },
        {
          critical: false,
          name: 'Reload Chunks',
          operation: async () => {
            await loadChunks();
            return { deletedChunks: 0, deletedFiles: 0 };
          },
        },
      ],
      setClearing,
      {
        partialSuccessMessage: 'Database was cleared but some data reload operations failed',
        partialSuccessTitle: 'Database Cleared',
        successMessage: 'Database has been cleared and data reloaded successfully',
        successTitle: 'Database Cleared',
      }
    );
  }, [clearAllData, toast, loadRecords, loadChunks, errorBoundary]);

  // Collection management handlers
  const handleCollectionChange = useCallback(
    (collectionId: string | null) => {
      const nextCollection = collectionId
        ? useVectorStatusUIStore
            .getState()
            .cachedCollections.find((collection) => collection.id === collectionId)
        : null;
      if (nextCollection?.systemRole === 'workspace-index') {
        return;
      }
      logger.info('Collection changed', { collectionId });
      setActiveCollectionId(collectionId);
    },
    [setActiveCollectionId]
  );

  const handleManualRefresh = useCallback(() => {
    void (async () => {
      await Promise.allSettled([loadRecords(), loadChunks()]);
    })();
  }, [loadRecords, loadChunks]);

  if (dbInitError) {
    return (
      <DatabasePanelFrame busy={false}>
        <DatabasePanelStateContent error={dbInitError} />
      </DatabasePanelFrame>
    );
  }

  if (!repository) {
    return (
      <DatabasePanelFrame busy>
        <DatabasePanelStateContent />
      </DatabasePanelFrame>
    );
  }

  return (
    <DatabasePanelFrame busy={false}>
      <Group className="min-h-0 flex-1" orientation="vertical">
        <Panel className="min-h-0" defaultSize="38%" maxSize="60%" minSize="26%">
          <div className="flex h-full flex-col overflow-hidden bg-panel-surface">
            {/* Header Toolbar — chrome controls (New | Refresh, Help, Settings) */}
            <div
              className="@container/database-toolbar h-12 flex-shrink-0 border-b bg-background"
              data-testid="database-panel-toolbar"
            >
              <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
                <div className="flex min-w-0 items-center">
                  <Button
                    aria-label="New"
                    className="h-8 gap-1.5 @[360px]:px-2.5 px-2 font-medium text-xs"
                    onClick={collectionDialogs.handleCreateCollection}
                    size="sm"
                    title="Create new collection"
                    variant="ghost"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span className="@[360px]:inline hidden">New</span>
                  </Button>
                </div>

                <div className="flex min-w-0 items-center @[360px]:gap-2 gap-1">
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          className="h-8 w-8 p-0"
                          disabled={refreshing}
                          onClick={handleManualRefresh}
                          size="sm"
                          variant="ghost"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${
                              refreshing ? 'animate-spin motion-reduce:animate-none' : ''
                            }`}
                          />
                          <span className="sr-only">Refresh</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Refresh database records</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button className="h-8 w-8 p-0" size="sm" variant="ghost">
                          <HelpCircle className="h-4 w-4 text-muted-foreground" />
                          <span className="sr-only">Help</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[300px]" side="bottom">
                        <p className="text-sm">
                          Collections let you search files with different AI models. Create separate
                          collections for code, documentation, or general content to get better
                          search results optimized for each use case.
                        </p>
                      </TooltipContent>
                    </Tooltip>

                    <div
                      className="mx-1 @[420px]:block hidden h-4 w-px bg-border"
                      data-testid="database-toolbar-divider"
                    />

                    <Popover onOpenChange={setShowSettings} open={showSettings}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PopoverTrigger asChild>
                            <button
                              aria-label="Import Settings"
                              className="group flex h-8 items-center gap-1.5 rounded-md border border-border bg-background @[360px]:px-2.5 px-2 text-sm transition-colors hover:border-accent-foreground/20 hover:bg-accent focus-visible:border-foreground/20 focus-visible:bg-accent/80 focus-visible:outline-none motion-reduce:transition-none"
                              type="button"
                            >
                              <Settings2 className="size-3.5 text-muted-foreground" />
                              <span className="@[360px]:inline hidden font-medium">Settings</span>
                              <Pencil className="@[440px]:block hidden size-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                        </TooltipTrigger>
                        {!showSettings && (
                          <TooltipContent side="bottom">
                            <div className="text-xs">Configure import and chunking</div>
                          </TooltipContent>
                        )}
                      </Tooltip>
                      <PopoverContent
                        align="end"
                        className="w-[min(96vw,48rem)] max-w-[calc(100vw-1.5rem)] p-0"
                        collisionPadding={16}
                        side="bottom"
                      >
                        <SettingsPanel
                          className="mt-0 border-none bg-transparent"
                          clearDatabaseProps={{
                            chunksCount: activeCollectionCounts.chunks,
                            clearAllData,
                            clearing,
                            countsPending: activeCollectionCountsPending,
                            onClear: handleClearDatabase,
                            recordsCount: activeCollectionCounts.records,
                            setShowClearDialog,
                            showClearDialog,
                          }}
                          importSettings={importSettings}
                        />
                      </PopoverContent>
                    </Popover>
                  </TooltipProvider>
                </div>
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
              <SearchCollectionSelector
                activeCollectionId={activeCollectionId}
                db={dbContext}
                onCollectionChange={handleCollectionChange}
                onCreateCollection={collectionDialogs.handleCreateCollection}
                onDeleteCollection={collectionDialogs.handleDeleteCollection}
                onEditCollection={collectionDialogs.handleEditCollection}
              />
              {isManagedCollection ? (
                <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-primary text-xs">
                  This collection is managed by background indexing. Manual DB imports are disabled
                  so the root-folder cache stays canonical.
                </div>
              ) : null}
            </div>

            {/* Import Progress Bar - above action footer */}
            {importFlow.showImportProgress && importFlow.progress && (
              <ImportProgressBar
                isCancelling={importFlow.isCancelling}
                onCancel={importFlow.handleCancelImport}
                onClose={() => importFlow.setShowImportProgress(false)}
                progress={importFlow.progress as EnhancedImportProgress}
              />
            )}

            {/* Action Footer — collection-contextual actions (Export, Import, Embeddings) */}
            <div
              className="@container/database-actions flex-shrink-0 border-t bg-background"
              data-testid="database-panel-actions"
            >
              <div
                className="flex h-12 flex-nowrap items-center justify-center @[420px]:gap-2 gap-1 @[420px]:px-4 px-1"
                data-testid="database-panel-actions-row"
              >
                <TooltipProvider delayDuration={200}>
                  <ExportDropdown
                    collapseLabelAtNarrowWidth
                    counts={activeCollectionCounts}
                    countsStatus={collectionCountsStatus}
                    exportHandlers={exportHandlers}
                  />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        aria-label={`Import (${importFlow.selectedFileCount})`}
                        className="flex h-8 @[420px]:min-w-[5.25rem] items-center gap-1.5 @[420px]:px-3 px-2"
                        disabled={
                          importFlow.isImporting ||
                          !activeCollectionId ||
                          importFlow.selectedFileCount === 0 ||
                          isManagedCollection
                        }
                        onClick={importFlow.handleImportClick}
                        size="sm"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        <span className="@[420px]:inline hidden font-medium">Import</span>
                        <span className="@[520px]:inline hidden text-[10px] opacity-70">
                          ({importFlow.selectedFileCount})
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {importFlow.selectedFileCount === 0
                        ? 'Select files to import first'
                        : isManagedCollection
                          ? 'Background indexing manages imports for this collection'
                          : activeCollectionId
                            ? `Import ${importFlow.selectedFileCount} files to collection`
                            : 'Select a collection first'}
                    </TooltipContent>
                  </Tooltip>

                  <EmbeddingActionsDropdown
                    {...dropdownProps}
                    className="shrink-0"
                    collapseLabelAtNarrowWidth
                  />
                </TooltipProvider>
              </div>
            </div>
          </div>
        </Panel>

        <Separator
          aria-label="Resize database panels"
          className="h-1 bg-border transition-colors hover:bg-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        />

        <Panel className="min-h-0" defaultSize="62%" minSize="30%">
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden border-border border-t">
            <SemanticSearchProvider
              {...(semanticSearchExecutor ? { searchExecutor: semanticSearchExecutor } : {})}
            >
              <DatabaseDemoSemanticSearchTestHookBridge />
              <CollectionBrowserView
                activeCollectionId={activeCollectionId}
                {...(activeCollectionName ? { activeCollectionName } : {})}
                activeCollectionSystemRole={activeCollectionSystemRole}
                chunks={chunks}
                height="100%"
                isLoading={initialLoading}
                loadChunkDetail={loadChunkDetail}
                loadFileChunkSummaries={loadFileChunkSummaries}
                pagination={{
                  currentPage: recordPagination.currentPage,
                  onPageChange: setRecordPage,
                  onPageSizeChange: setRecordPageSize,
                  pageSize: recordPagination.pageSize,
                  totalRecords: recordPagination.totalRecords,
                }}
                records={records}
              />
            </SemanticSearchProvider>
          </div>
        </Panel>
      </Group>

      {/* Clear Database Dialog - triggered from Import Settings */}
      <ClearDatabaseDialog
        chunksCount={activeCollectionCounts.chunks}
        clearing={clearing}
        countsPending={activeCollectionCountsPending}
        onClear={handleClearDatabase}
        recordsCount={activeCollectionCounts.records}
        setShowClearDialog={setShowClearDialog}
        showClearDialog={showClearDialog}
      />

      {/* Create Collection Dialog */}
      {collectionDialogs.createCollectionOpen && (
        <CreateCollectionDialog
          db={dbContext}
          onClose={collectionDialogs.closeCreateDialog}
          onCreated={(newSetId: string, newSet: EmbeddingSet) => {
            upsertCachedCollection(collectionCacheSnapshotFromEmbeddingSet(newSet));
            handleCollectionChange(newSetId);
            collectionDialogs.closeCreateDialog();
          }}
          repository={embeddingSetsRepository}
        />
      )}

      {/* Rename Collection Dialog */}
      {collectionDialogs.renameDialogOpen && collectionDialogs.selectedCollection && (
        <RenameEmbeddingSetDialog
          embeddingSet={{
            chunkCount: collectionDialogs.selectedCollection.chunkCount,
            createdAt: collectionDialogs.selectedCollection.createdAt,
            dimensions: collectionDialogs.selectedCollection.dimensions,
            distance: collectionDialogs.selectedCollection.distance,
            embeddingCount: collectionDialogs.selectedCollection.embeddingCount,
            fileCount: collectionDialogs.selectedCollection.fileCount,
            id: collectionDialogs.selectedCollection.id,
            modelId: collectionDialogs.selectedCollection.modelId,
            modelKey: collectionDialogs.selectedCollection.modelKey,
            ...(collectionDialogs.selectedCollection.name && {
              name: collectionDialogs.selectedCollection.name,
            }),
            ...(collectionDialogs.selectedCollection.description && {
              description: collectionDialogs.selectedCollection.description,
            }),
            ...(collectionDialogs.selectedCollection.tags && {
              tags: collectionDialogs.selectedCollection.tags,
            }),
            ...(collectionDialogs.selectedCollection.category && {
              category: collectionDialogs.selectedCollection.category,
            }),
          }}
          onOpenChange={(open: boolean) => {
            if (!open) {
              collectionDialogs.closeRenameDialog();
            }
          }}
          onSetRenamed={() => {
            collectionDialogs.closeRenameDialog();
          }}
          open={collectionDialogs.renameDialogOpen}
          repository={embeddingSetsRepository}
        />
      )}

      {/* Delete Collection Dialog */}
      {collectionDialogs.deleteDialogOpen && collectionDialogs.selectedCollection && (
        <DeleteEmbeddingSetDialog
          db={dbContext as never}
          embeddingSet={{
            createdAt: collectionDialogs.selectedCollection.createdAt,
            dimensions: collectionDialogs.selectedCollection.dimensions,
            distance: collectionDialogs.selectedCollection.distance,
            id: collectionDialogs.selectedCollection.id,
            modelId: collectionDialogs.selectedCollection.modelId,
            modelKey: collectionDialogs.selectedCollection.modelKey,
            ...(collectionDialogs.selectedCollection.name && {
              name: collectionDialogs.selectedCollection.name,
            }),
            ...(collectionDialogs.selectedCollection.description && {
              description: collectionDialogs.selectedCollection.description,
            }),
            ...(collectionDialogs.selectedCollection.tags && {
              tags: collectionDialogs.selectedCollection.tags,
            }),
            ...(collectionDialogs.selectedCollection.category && {
              category: collectionDialogs.selectedCollection.category,
            }),
            chunkCount: collectionDialogs.selectedCollection.chunkCount,
          }}
          onOpenChange={(open: boolean) => {
            if (!open) {
              collectionDialogs.closeDeleteDialog();
            }
          }}
          onSetDeleted={(deletedId: string) => {
            collectionDialogs.closeDeleteDialog();
            // Clear selection if deleted collection was active
            if (activeCollectionId === deletedId) {
              setActiveCollectionId(null);
            }
          }}
          open={collectionDialogs.deleteDialogOpen}
        />
      )}
    </DatabasePanelFrame>
  );
}
