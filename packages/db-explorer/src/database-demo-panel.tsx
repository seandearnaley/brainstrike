import {
  type EmbeddingSet,
  useClearAllData,
  useDbProviderError,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  useEnsureModelRegistry,
  useModelRegistryStore,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import {
  CreateEmbeddingSetDialog,
  DeleteEmbeddingSetDialog,
  RenameEmbeddingSetDialog,
} from '@brainstrike/vector-management';
import { Database, FileText, HelpCircle, Pencil, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  ClearDatabaseDialog,
  CollectionBrowserView,
  ExportDropdown,
  ImportProgressBar,
  SearchCollectionSelector,
  SettingsPanel,
} from './components';
import { SemanticSearchProvider } from './contexts/semantic-search-context';
import {
  createImportCompletionHandler,
  useAvailableModels,
  useAvailableProviders,
  useCollectionDialogs,
  useDatabaseErrorBoundary,
  useExportHandlers,
  useImportSettings,
  useSemanticSearchExecutor,
} from './hooks';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import { useDatabaseDemoData } from './use-database-demo-data';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
}

const logger = createLogger('DatabaseDemoPanel');

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
  const setActiveCollectionId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);
  const setIsImporting = useVectorStatusUIStore((s) => s.setIsImporting);

  // Get embedding sets repository from DbProvider (Drizzle-based)
  const embeddingSetsRepository = useEmbeddingSetsRepository();

  // Get enabled models from model registry
  const { models, providers, isLoading: isRegistryLoading } = useModelRegistryStore();
  useEnsureModelRegistry({ db: dbContext });

  const availableModels = useAvailableModels(models);
  const availableProviders = useAvailableProviders(providers);

  const showSettings = useDatabaseDemoStore((s) => s.showSettings);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);

  const importSettings = useImportSettings();
  const [chunkRepository, setChunkRepository] =
    useState<UseImportFlowResult['chunkRepository']>(null);
  const resolveActiveCollectionId = useCallback(() => activeCollectionId, [activeCollectionId]);

  // Read import state from Zustand store (shared with VectorStatus for query pausing)
  const isImportActive = useVectorStatusUIStore((s) => s.isImporting);

  const data = useDatabaseDemoData({
    repository,
    chunkRepository,
    toast,
    database: dbContext,
    activeCollectionId,
    isImporting: isImportActive,
  });
  const { records, chunks, refreshing, loadRecords, loadChunks } = data;

  const filteredRecords = useMemo(() => {
    if (!activeCollectionId) {
      return [];
    }
    return records.filter((record) => record.embeddingSetId === activeCollectionId);
  }, [records, activeCollectionId]);

  const filteredChunks = useMemo(() => {
    if (!activeCollectionId) {
      return [];
    }
    return chunks.filter((chunk) => chunk.embeddingSetId === activeCollectionId);
  }, [chunks, activeCollectionId]);

  const exportHandlers = useExportHandlers(filteredRecords, filteredChunks, toast);

  // Create semantic search executor for the collection browser
  // Use dbChunkRepository (from hook) which is always available when DB is ready,
  // rather than chunkRepository (from import flow) which requires import to be triggered
  const semanticSearchExecutor = useSemanticSearchExecutor({
    chunkRepository: dbChunkRepository,
    fileRepository: repository,
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
    (results: EnhancedImportResult[]) => {
      const handler = createImportCompletionHandler(toast, loadRecords, loadChunks);
      handler(results);
    },
    [toast, loadRecords, loadChunks]
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
      <PanelGroup className="min-h-0 flex-1" direction="vertical">
        <Panel className="min-h-0" defaultSize={38} maxSize={60} minSize={26}>
          <div className="flex h-full flex-col overflow-hidden bg-linear-to-b from-[#fdfcfb] to-[#f2f0ef] dark:from-[#1a1816] dark:to-[#0a0a0a]">
            <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
              <SearchCollectionSelector
                activeCollectionId={activeCollectionId}
                db={dbContext}
                onCollectionChange={handleCollectionChange}
                onCreateCollection={collectionDialogs.handleCreateCollection}
                onDeleteCollection={collectionDialogs.handleDeleteCollection}
                onEditCollection={collectionDialogs.handleEditCollection}
              />
            </div>

            {/* Import Progress Bar - above footer */}
            {importFlow.showImportProgress && importFlow.progress && (
              <ImportProgressBar
                isCancelling={importFlow.isCancelling}
                onCancel={importFlow.handleCancelImport}
                onClose={() => importFlow.setShowImportProgress(false)}
                progress={importFlow.progress as EnhancedImportProgress}
              />
            )}

            {/* Sticky Footer */}
            <div className="flex flex-shrink-0 items-center justify-between border-t bg-background p-2 px-4">
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

                <div className="mx-1 h-4 w-px bg-border" />

                <Popover onOpenChange={setShowSettings} open={showSettings}>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                          <button
                            aria-label="Import Settings"
                            className="group flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm transition-colors hover:border-accent-foreground/20 hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
                            type="button"
                          >
                            <Settings2 className="size-3.5 text-muted-foreground" />
                            <span className="font-medium">Settings</span>
                            <Pencil className="size-3 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                      </TooltipTrigger>
                      {!showSettings && (
                        <TooltipContent side="top">
                          <div className="text-xs">Configure import and chunking</div>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                  <PopoverContent align="start" className="w-80 p-0" side="top">
                    <SettingsPanel
                      className="mt-0 border-none bg-transparent"
                      clearDatabaseProps={{
                        clearAllData,
                        records,
                        chunks,
                        clearing,
                        showClearDialog,
                        setShowClearDialog,
                        onClear: handleClearDatabase,
                      }}
                      importSettings={importSettings}
                    />
                  </PopoverContent>
                </Popover>
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
                        variant="outline"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                        <span className="sr-only">Refresh</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Refresh database records</TooltipContent>
                  </Tooltip>

                  <ExportDropdown
                    chunks={filteredChunks}
                    exportHandlers={exportHandlers}
                    records={filteredRecords}
                  />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        className="flex h-8 items-center gap-1.5"
                        disabled={
                          importFlow.isImporting ||
                          !activeCollectionId ||
                          importFlow.selectedFileCount === 0
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
                        : activeCollectionId
                          ? `Import ${importFlow.selectedFileCount} files to collection`
                          : 'Select a collection first'}
                    </TooltipContent>
                  </Tooltip>

                  <div className="mx-1 h-4 w-px bg-border" />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button className="h-8 w-8 p-0" size="sm" variant="ghost">
                        <HelpCircle className="h-4 w-4 text-muted-foreground" />
                        <span className="sr-only">Help</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[300px]" side="top">
                      <p className="text-sm">
                        Collections let you search files with different AI models. Create separate
                        collections for code, documentation, or general content to get better search
                        results optimized for each use case.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          </div>
        </Panel>

        <PanelResizeHandle className="h-1 bg-border transition-colors hover:bg-border/80" />

        <Panel className="min-h-0" defaultSize={62} minSize={30}>
          <div className="relative flex h-full min-h-0 flex-col overflow-hidden border-border border-t">
            <SemanticSearchProvider
              {...(semanticSearchExecutor ? { searchExecutor: semanticSearchExecutor } : {})}
            >
              <CollectionBrowserView
                activeCollectionId={activeCollectionId}
                chunks={chunks}
                height="100%"
                isLoading={refreshing}
                records={records}
              />
            </SemanticSearchProvider>

            {/* Empty state when no collection is selected */}
            {!activeCollectionId && (
              <div className="absolute inset-0 z-10">
                <EmptyState
                  description="Create or select a collection to start importing files and searching with semantic embeddings"
                  icon={<Database />}
                  title="No collection selected"
                />
              </div>
            )}
          </div>
        </Panel>
      </PanelGroup>

      {/* Clear Database Dialog - triggered from Import Settings */}
      <ClearDatabaseDialog
        chunks={chunks}
        clearing={clearing}
        onClear={handleClearDatabase}
        records={records}
        setShowClearDialog={setShowClearDialog}
        showClearDialog={showClearDialog}
      />

      {/* Create Collection Dialog */}
      {collectionDialogs.createCollectionOpen && (
        <CreateEmbeddingSetDialog
          isLoading={isRegistryLoading}
          models={availableModels}
          onOpenChange={(open) => {
            if (!open) {
              collectionDialogs.closeCreateDialog();
            }
          }}
          onSetCreated={(newSetId?: string) => {
            if (newSetId) {
              handleCollectionChange(newSetId);
            }
            collectionDialogs.closeCreateDialog();
            // Reload collections (SearchCollectionSelector listens to event)
          }}
          open={collectionDialogs.createCollectionOpen}
          providers={availableProviders}
          repository={embeddingSetsRepository}
        />
      )}

      {/* Rename Collection Dialog */}
      {collectionDialogs.renameDialogOpen && collectionDialogs.selectedCollection && (
        <RenameEmbeddingSetDialog
          embeddingSet={
            {
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
            } satisfies EmbeddingSet
          }
          onOpenChange={(open) => {
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
            chunkCount: chunks.filter(
              (c) => c.embeddingSetId === collectionDialogs.selectedCollection?.id
            ).length,
          }}
          onOpenChange={(open) => {
            if (!open) {
              collectionDialogs.closeDeleteDialog();
            }
          }}
          onSetDeleted={(deletedId) => {
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
