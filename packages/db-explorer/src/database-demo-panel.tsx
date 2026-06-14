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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import {
  ClearDatabaseDialog,
  CollectionBrowserView,
  ExportDropdown,
  ImportProgressBar,
  SearchCollectionSelector,
  SettingsPanel,
} from './components';
import {
  createImportCompletionHandler,
  useAvailableModels,
  useAvailableProviders,
  useCollectionDialogs,
  useDatabaseErrorBoundary,
  useExportHandlers,
  useImportSettings,
} from './hooks';
import {
  SemanticSearchProvider,
  useSemanticSearch,
  useSemanticSearchExecutor,
} from './semantic-search';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import { useDatabaseDemoData } from './use-database-demo-data';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
}

function collectionCacheSnapshotFromEmbeddingSet(set: EmbeddingSet): CachedCollection {
  return {
    id: set.id,
    modelKey: set.modelKey,
    modelId: set.modelId,
    dimensions: set.dimensions,
    distance: set.distance,
    createdAt: set.createdAt,
    name: set.name ?? null,
    description: set.description ?? null,
    tags: set.tags ?? null,
    category: set.category ?? null,
    fileCount: 0,
    chunkCount: 0,
    embeddingCount: 0,
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
    toast,
    onError: (error) => {
      logger.error('Database operation error', { error });
    },
  });

  const [clearing, setClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);

  // Collection dialog management (create, rename, delete)
  const collectionDialogs = useCollectionDialogs();

  // Use Zustand store directly as single source of truth for collection selection and import state
  const activeCollectionId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const cachedCollections = useVectorStatusUIStore((s) => s.cachedCollections);
  const activeCollection = useMemo(() => {
    if (!activeCollectionId) {
      return null;
    }
    return cachedCollections.find((collection) => collection.id === activeCollectionId) ?? null;
  }, [activeCollectionId, cachedCollections]);
  const activeCollectionName = useMemo(
    () => activeCollection?.name ?? activeCollection?.modelKey ?? undefined,
    [activeCollection]
  );
  const setActiveCollectionId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);
  const upsertCachedCollection = useVectorStatusUIStore((s) => s.upsertCachedCollection);
  const setIsImporting = useVectorStatusUIStore((s) => s.setIsImporting);
  const managedCollectionId = useBackgroundIndexingPreferencesStore((s) => s.managedCollectionId);
  const isManagedCollection = Boolean(
    activeCollectionId &&
      (activeCollection?.systemRole === 'workspace-index' ||
        activeCollectionId === managedCollectionId)
  );

  // Get embedding sets repository from DbProvider (Drizzle-based)
  const embeddingSetsRepository = useEmbeddingSetsRepository();

  // Get enabled models from model registry. Selector-scoped subscriptions:
  // a bare useModelRegistryStore() re-renders this entire panel on every
  // store update — including per-tick setDownloadProgress during downloads.
  const models = useModelRegistryStore((s) => s.models);
  const providers = useModelRegistryStore((s) => s.providers);
  const isRegistryLoading = useModelRegistryStore((s) => s.isLoading);
  useEnsureModelRegistry({ db: dbContext });
  const { catalog: runtimeEmbeddingCatalog, isLoading: isRuntimeCatalogLoading } =
    useLocalRuntimeEmbeddingModelCatalog({
      verifyEmbeddingDimensions: true,
      maxVerificationModels: 8,
    });

  const availableModels = useAvailableModels(models, runtimeEmbeddingCatalog);
  const availableProviders = useAvailableProviders(providers, runtimeEmbeddingCatalog);

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
    repository,
    chunkRepository,
    toast,
    database: dbContext,
    activeCollectionId,
    isImporting: isImportActive,
    isEmbeddingActive,
    recordPage,
    recordPageSize,
  });
  const {
    collectionCounts,
    collectionCountsStatus,
    records,
    chunks,
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
      enableChunking: importSettings.enableChunking,
      chunkingStrategy: importSettings.chunkingStrategy,
      chunkingStrategyExplicit: importSettings.chunkingStrategyExplicit,
      chunkSize: importSettings.chunkSize,
      chunkOverlap: importSettings.chunkOverlap,
      tokenTrueSizing: importSettings.tokenTrueSizing,
      chunkTokenLimit: importSettings.chunkTokenLimit,
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
    importSettings: importFlowSettings,
    toast,
    onImportComplete: handleImportComplete,
    onChunkRepositoryChange: setChunkRepository,
    embeddingQueue,
    resolveActiveCollectionId,
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
        recordCount: records.length,
        recordPagination: {
          currentPage: recordPagination.currentPage,
          pageSize: recordPagination.pageSize,
          totalRecords: recordPagination.totalRecords,
        },
        selectedFileCount: importFlow.selectedFileCount,
        progress: importFlow.progress
          ? {
              phase: importFlow.progress.phase,
              total: importFlow.progress.total,
              completed: importFlow.progress.completed,
              current: importFlow.progress.current ?? '',
              errors: importFlow.progress.errors.map((entry) => ({
                file: entry.file,
                error: entry.error,
              })),
              chunkingProgress: importFlow.progress.chunkingProgress
                ? {
                    filesProcessed: importFlow.progress.chunkingProgress.filesProcessed,
                    totalFiles: importFlow.progress.chunkingProgress.totalFiles,
                    chunksCreated: importFlow.progress.chunkingProgress.chunksCreated,
                    currentFile: importFlow.progress.chunkingProgress.currentFile ?? '',
                    strategyUsed: importFlow.progress.chunkingProgress.strategyUsed ?? '',
                  }
                : null,
            }
          : null,
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
        title: 'Clear Function Not Available',
        description: 'Database clear functionality is not ready.',
        variant: 'destructive',
      });
      return;
    }

    setShowClearDialog(false);

    await errorBoundary.executeMultipleOperations(
      [
        {
          operation: async () => clearAllData(),
          name: 'Clear Database',
          critical: true,
        },
        {
          operation: async () => {
            await loadRecords();
            return { deletedFiles: 0, deletedChunks: 0 };
          },
          name: 'Reload File Records',
          critical: false,
        },
        {
          operation: async () => {
            await loadChunks();
            return { deletedFiles: 0, deletedChunks: 0 };
          },
          name: 'Reload Chunks',
          critical: false,
        },
      ],
      setClearing,
      {
        successTitle: 'Database Cleared',
        successMessage: 'Database has been cleared and data reloaded successfully',
        partialSuccessTitle: 'Database Cleared',
        partialSuccessMessage: 'Database was cleared but some data reload operations failed',
      }
    );
  }, [clearAllData, toast, loadRecords, loadChunks, errorBoundary]);

  // Collection management handlers
  const handleCollectionChange = useCallback(
    (collectionId: string | null) => {
      const nextCollection = collectionId
        ? cachedCollections.find((collection) => collection.id === collectionId)
        : null;
      if (nextCollection?.systemRole === 'workspace-index') {
        return;
      }
      logger.info('Collection changed', { collectionId });
      setActiveCollectionId(collectionId);
    },
    [cachedCollections, setActiveCollectionId]
  );

  const handleManualRefresh = useCallback(() => {
    void (async () => {
      await Promise.allSettled([loadRecords(), loadChunks()]);
    })();
  }, [loadRecords, loadChunks]);

  if (dbInitError) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4" />
          </CardTitle>
          <CardDescription className="text-red-600 text-xs">
            Database failed to initialize
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="break-all text-red-700 text-xs" data-testid="db-init-error">
            {String(dbInitError.message || dbInitError)}
          </div>
          <div className="text-muted-foreground text-xs">
            Ensure pgvector is available in Electron and try restarting the app.
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!repository) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4" />
          </CardTitle>
          <CardDescription className="text-xs">Database is initializing...</CardDescription>
        </CardHeader>
        <CardContent className="flex h-32 items-center justify-center">
          <div className="text-muted-foreground text-sm">Loading PGlite database...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="database-demo-panel">
      <Group className="min-h-0 flex-1" orientation="vertical">
        <Panel className="min-h-0" defaultSize="38%" maxSize="60%" minSize="26%">
          <div className="flex h-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
            {/* Header Toolbar — chrome controls (New | Refresh, Help, Settings) */}
            <div
              className="flex flex-shrink-0 items-center justify-between gap-2 border-b bg-background px-4 py-2"
              data-testid="database-panel-toolbar"
            >
              <div className="flex items-center gap-2">
                <Button
                  className="h-8 gap-1.5 px-2.5 font-medium text-xs"
                  onClick={collectionDialogs.handleCreateCollection}
                  size="sm"
                  title="Create new collection"
                  variant="ghost"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New</span>
                </Button>
              </div>

              <div className="flex items-center gap-2">
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
                        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
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
                        collections for code, documentation, or general content to get better search
                        results optimized for each use case.
                      </p>
                    </TooltipContent>
                  </Tooltip>

                  <div className="mx-1 h-4 w-px bg-border" />

                  <Popover onOpenChange={setShowSettings} open={showSettings}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <button
                            aria-label="Import Settings"
                            className="group flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm transition-colors hover:border-accent-foreground/20 hover:bg-accent focus-visible:border-foreground/20 focus-visible:bg-accent/80 focus-visible:outline-none"
                            type="button"
                          >
                            <Settings2 className="size-3.5 text-muted-foreground" />
                            <span className="font-medium">Settings</span>
                            <Pencil className="size-3 text-muted-foreground" />
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
                          clearAllData,
                          recordsCount: activeCollectionCounts.records,
                          chunksCount: activeCollectionCounts.chunks,
                          countsPending: activeCollectionCountsPending,
                          clearing,
                          showClearDialog,
                          setShowClearDialog,
                          onClear: handleClearDatabase,
                        }}
                        importSettings={importSettings}
                      />
                    </PopoverContent>
                  </Popover>
                </TooltipProvider>
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
              className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-2"
              data-testid="database-panel-actions"
            >
              <TooltipProvider delayDuration={200}>
                <ExportDropdown
                  counts={activeCollectionCounts}
                  countsStatus={collectionCountsStatus}
                  exportHandlers={exportHandlers}
                />

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      className="flex h-8 items-center gap-1.5"
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
                      <span className="font-medium">Import</span>
                      <span className="text-[10px] opacity-70">
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

                <EmbeddingActionsDropdown {...dropdownProps} className="shrink-0" />
              </TooltipProvider>
            </div>
          </div>
        </Panel>

        <Separator className="h-1 bg-border transition-colors hover:bg-border/80" />

        <Panel className="min-h-0" defaultSize="62%" minSize="30%">
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden border-border border-t">
            <SemanticSearchProvider
              {...(semanticSearchExecutor ? { searchExecutor: semanticSearchExecutor } : {})}
            >
              <DatabaseDemoSemanticSearchTestHookBridge />
              <CollectionBrowserView
                activeCollectionId={activeCollectionId}
                {...(activeCollectionName ? { activeCollectionName } : {})}
                activeCollectionSystemRole={activeCollection?.systemRole ?? null}
                chunks={chunks}
                height="100%"
                isLoading={refreshing}
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
        <CreateEmbeddingSetDialog
          isLoading={isRegistryLoading || isRuntimeCatalogLoading}
          models={availableModels}
          onOpenChange={(open: boolean) => {
            if (!open) {
              collectionDialogs.closeCreateDialog();
            }
          }}
          onSetCreated={(newSetId: string, newSet: EmbeddingSet) => {
            upsertCachedCollection(collectionCacheSnapshotFromEmbeddingSet(newSet));
            handleCollectionChange(newSetId);
            collectionDialogs.closeCreateDialog();
          }}
          open={collectionDialogs.createCollectionOpen}
          providers={availableProviders}
          repository={embeddingSetsRepository}
        />
      )}

      {/* Rename Collection Dialog */}
      {collectionDialogs.renameDialogOpen && collectionDialogs.selectedCollection && (
        <RenameEmbeddingSetDialog
          embeddingSet={{
            id: collectionDialogs.selectedCollection.id,
            modelKey: collectionDialogs.selectedCollection.modelKey,
            modelId: collectionDialogs.selectedCollection.modelId,
            dimensions: collectionDialogs.selectedCollection.dimensions,
            distance: collectionDialogs.selectedCollection.distance,
            createdAt: collectionDialogs.selectedCollection.createdAt,
            fileCount: collectionDialogs.selectedCollection.fileCount,
            chunkCount: collectionDialogs.selectedCollection.chunkCount,
            embeddingCount: collectionDialogs.selectedCollection.embeddingCount,
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
            id: collectionDialogs.selectedCollection.id,
            modelKey: collectionDialogs.selectedCollection.modelKey,
            modelId: collectionDialogs.selectedCollection.modelId,
            dimensions: collectionDialogs.selectedCollection.dimensions,
            distance: collectionDialogs.selectedCollection.distance,
            createdAt: collectionDialogs.selectedCollection.createdAt,
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
    </div>
  );
}
