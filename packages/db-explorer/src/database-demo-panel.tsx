import {
  type EmbeddingSet,
  EmbeddingSetsRepository,
  useClearAllData,
  useDbProviderError,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  ModelRegistryManager,
  parseProviderModelKey,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/embeddings';
import { useEmbeddingPreferencesStore, useVectorStatusUIStore } from '@brainstrike/preferences';
import type { QueueAdapter } from '@brainstrike/queue';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import {
  CreateEmbeddingSetDialog,
  ManageEmbeddingSetsDialog,
} from '@brainstrike/vector-management';
import { ChevronDown, ChevronRight, Database, FileText, Info, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChunksViewTable,
  ClearDatabaseDialog,
  DbInfoDisplay,
  ExportDropdown,
  FilesViewTable,
  ImportProgressDisplay,
  SearchCollectionSelector,
  SearchInterface,
  SearchViewTable,
  SettingsPanel,
  ViewSelector,
} from './components';
import {
  createImportCompletionHandler,
  useDatabaseErrorBoundary,
  useDocumentCount,
  useExportHandlers,
  useImportSettings,
  useSearchFunctionality,
} from './hooks';
import { useFileCollectionStatus } from './hooks/use-file-collection-status';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import type { FileCollectionStatus } from './types/file-collection-status';
import { useDatabaseDemoData } from './use-database-demo-data';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';
import { usePendingChunks } from './use-pending-chunks';
import { getActiveEmbeddingSetId, setActiveEmbeddingSetId } from './vector-preferences';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
}

type AvailableModel = {
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  provider: string;
  description?: string;
  tags?: string[];
  pricePer1MTokens?: number;
  origin?: string;
};

/**
 * Creates a single model object from provider and modelId
 * Extracted to reduce cognitive complexity
 */
function createModelFromProviderAndId(
  provider: EmbeddingProviderType,
  modelId: string,
  modelRegistry: Record<string, unknown>
): AvailableModel {
  const modelKey = provider === 'local' ? modelId : `${provider}::${modelId}`;
  const modelConfig = modelRegistry[modelKey] as
    | {
        dimensions?: number;
        description?: string;
        tags?: string[];
        pricePer1MTokens?: number;
        origin?: string;
      }
    | undefined;

  const dimensions = modelConfig?.dimensions ?? STANDARD_EMBEDDING_DIMENSION;

  const parsed = parseProviderModelKey(modelKey);
  let providerLabel = 'Local';
  if (parsed?.provider === 'local') {
    providerLabel = 'Local';
  } else if (parsed?.provider) {
    providerLabel = parsed.provider.charAt(0).toUpperCase() + parsed.provider.slice(1);
  }

  const model: AvailableModel = {
    modelKey,
    modelId,
    dimensions,
    distance: 'cosine',
    provider: providerLabel,
  };

  if (modelConfig?.description) model.description = modelConfig.description;
  if (modelConfig?.tags) model.tags = modelConfig.tags;
  if (modelConfig?.pricePer1MTokens !== undefined)
    model.pricePer1MTokens = modelConfig.pricePer1MTokens;
  if (modelConfig?.origin) model.origin = modelConfig.origin;

  return model;
}

/**
 * Builds available models list from enabled models in preferences
 * Extracted to reduce cognitive complexity of DatabaseDemoPanel
 */
function buildAvailableModelsFromPreferences(
  enabledModelsByProvider: Record<EmbeddingProviderType, string[]>
): AvailableModel[] {
  const models: AvailableModel[] = [];
  const modelRegistry = ModelRegistryManager.listModels();

  (Object.keys(enabledModelsByProvider) as EmbeddingProviderType[]).forEach((provider) => {
    const enabledModels = enabledModelsByProvider[provider] ?? [];
    enabledModels.forEach((modelId) => {
      models.push(createModelFromProviderAndId(provider, modelId, modelRegistry));
    });
  });

  return models;
}

// Factory reset is now provided via the shared Preferences UI (FactoryResetPanel).

/**
 * Seeds search state from persisted values on first mount
 * Extracted to reduce cognitive complexity of DatabaseDemoPanel
 */
function seedSearchStateFromPersistence(
  persistedSearchQuery: string,
  persistedThreshold: number,
  searchFunctionality: {
    searchQuery: string;
    searchThreshold: number;
    setSearchQuery: (q: string) => void;
    setSearchThreshold: (t: number) => void;
  }
): void {
  if (persistedSearchQuery && persistedSearchQuery !== searchFunctionality.searchQuery) {
    searchFunctionality.setSearchQuery(persistedSearchQuery);
  }
  if (
    Number.isFinite(persistedThreshold) &&
    persistedThreshold !== searchFunctionality.searchThreshold
  ) {
    searchFunctionality.setSearchThreshold(persistedThreshold);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is a large React component that coordinates multiple sub-systems (import flow, search, vector management, factory reset). Complexity has been reduced by extracting helper functions for model building, factory reset logic, and search state initialization. Further reduction would require splitting into smaller components which would harm readability given the tight coupling of state.
export function DatabaseDemoPanel({ embeddingQueue = null }: DatabaseDemoPanelProps = {}) {
  const repository = useFileRecordRepository();
  const dbInitError = useDbProviderError();
  const clearAllData = useClearAllData();
  const dbContext = usePGliteDatabase();

  const { toast } = useToast();
  const errorBoundary = useDatabaseErrorBoundary({
    toast,
    onError: (error) => {
      console.error('Database operation error:', error);
    },
  });

  const [clearing, setClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [manageCollectionsOpen, setManageCollectionsOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    getActiveEmbeddingSetId()
  );
  const [activeCollection, setActiveCollection] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [fileStatuses, setFileStatuses] = useState<Map<string, FileCollectionStatus>>(new Map());

  useEffect(() => {
    const unsubscribe = useVectorStatusUIStore.subscribe((state) => {
      const nextId = state.activeEmbeddingSetId;
      setActiveCollectionId((prev) => {
        const normalized = typeof nextId === 'string' && nextId.trim() ? nextId : null;
        return prev === normalized ? prev : normalized;
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Create embedding sets repository
  const embeddingSetsRepository = useMemo(
    () => (dbContext ? new EmbeddingSetsRepository(dbContext as never) : null),
    [dbContext]
  );

  // Get enabled models from preferences for Create dialog
  const { enabledModelsByProvider } = useEmbeddingPreferencesStore();
  const availableModels = useMemo(
    () => buildAvailableModelsFromPreferences(enabledModelsByProvider),
    [enabledModelsByProvider]
  );

  const expandedFileIds = useDatabaseDemoStore((s) => s.expandedFileIds);
  const setSelectedView = useDatabaseDemoStore((s) => s.setSelectedView);
  const selectedView = useDatabaseDemoStore((s) => s.selectedView);
  const showSettings = useDatabaseDemoStore((s) => s.showSettings);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);
  const addExpanded = useDatabaseDemoStore((s) => s.addExpanded);
  const removeExpanded = useDatabaseDemoStore((s) => s.removeExpanded);
  const setSearchQueryPersist = useDatabaseDemoStore((s) => s.setSearchQuery);
  const setSearchThresholdPersist = useDatabaseDemoStore((s) => s.setSearchThreshold);
  const persistedSearchQuery = useDatabaseDemoStore((s) => s.searchQuery);
  const persistedThreshold = useDatabaseDemoStore((s) => s.searchThreshold);
  const expandedFiles = useMemo(() => new Set(expandedFileIds), [expandedFileIds]);

  const importSettings = useImportSettings();
  const [chunkRepository, setChunkRepository] =
    useState<UseImportFlowResult['chunkRepository']>(null);
  const resolveActiveCollectionId = useCallback(() => activeCollectionId, [activeCollectionId]);

  const data = useDatabaseDemoData({
    repository,
    chunkRepository,
    toast,
    database: dbContext,
    activeCollectionId,
  });
  const { records, chunks, refreshing, dbInfo, loadRecords, loadChunks } = data;

  const filteredRecords = useMemo(() => {
    if (!activeCollectionId) return [];
    return records.filter((record) => record.embeddingSetId === activeCollectionId);
  }, [records, activeCollectionId]);

  const filteredChunks = useMemo(() => {
    if (!activeCollectionId) return [];
    return chunks.filter((chunk) => chunk.embeddingSetId === activeCollectionId);
  }, [chunks, activeCollectionId]);

  const { pendingChunkIds } = usePendingChunks({
    database: dbContext,
    resolveActiveSetId: getActiveEmbeddingSetId,
  });

  const exportHandlers = useExportHandlers(filteredRecords, filteredChunks, toast);

  const searchFunctionality = useSearchFunctionality(chunkRepository, repository, toast);

  // Get file collection status hook
  const { getFileStatus } = useFileCollectionStatus(activeCollectionId);

  // Get document count for search tab
  const documentCount = useDocumentCount(activeCollectionId);

  // Load active collection details when activeCollectionId changes
  useEffect(() => {
    if (!dbContext || !activeCollectionId || !embeddingSetsRepository) {
      setActiveCollection(null);
      return;
    }

    void embeddingSetsRepository.getById(activeCollectionId).then((set: EmbeddingSet | null) => {
      if (set) {
        setActiveCollection({ id: set.id, name: set.name ?? set.modelId });
      } else {
        setActiveCollection(null);
      }
    });
  }, [dbContext, activeCollectionId, embeddingSetsRepository]);

  // Load file statuses when records or activeCollectionId changes
  useEffect(() => {
    if (!activeCollectionId) {
      setFileStatuses(new Map());
      return;
    }
    if (!filteredRecords.length) {
      setFileStatuses(new Map());
      return;
    }

    const fileIds = filteredRecords.map((r) => r.id);
    void getFileStatus(fileIds).then((statuses) => {
      const statusMap = new Map(statuses.map((s) => [s.fileId, s]));
      setFileStatuses(statusMap);
    });
  }, [filteredRecords, activeCollectionId, getFileStatus]);

  // Seed search state from persistence on first mount
  useEffect(() => {
    seedSearchStateFromPersistence(persistedSearchQuery, persistedThreshold, searchFunctionality);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setSearchQueryPersist(searchFunctionality.searchQuery);
  }, [searchFunctionality.searchQuery, setSearchQueryPersist]);

  useEffect(() => {
    setSearchThresholdPersist(searchFunctionality.searchThreshold);
  }, [searchFunctionality.searchThreshold, setSearchThresholdPersist]);

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

  const toggleFileExpansion = useCallback(
    (fileId: string) => {
      if (expandedFiles.has(fileId)) removeExpanded(fileId);
      else addExpanded(fileId);
    },
    [expandedFiles, addExpanded, removeExpanded]
  );

  const getFileChunks = useCallback(
    (fileId: string) => filteredChunks.filter((chunk) => chunk.fileRecordId === fileId),
    [filteredChunks]
  );

  // Collection management handlers
  const handleCollectionChange = useCallback((collectionId: string | null) => {
    console.log('[DatabaseDemoPanel] Collection changed to:', collectionId);
    setActiveCollectionId(collectionId);
    setActiveEmbeddingSetId(collectionId);
    console.log(
      '[DatabaseDemoPanel] After setActiveEmbeddingSetId, checking getActive:',
      getActiveEmbeddingSetId()
    );
  }, []);

  const handleManageCollections = useCallback(() => {
    setManageCollectionsOpen(true);
  }, []);

  const handleCreateCollection = useCallback(() => {
    setCreateCollectionOpen(true);
  }, []);

  const handleManualRefresh = useCallback(() => {
    void (async () => {
      await Promise.allSettled([loadRecords(), loadChunks()]);
    })();
  }, [loadRecords, loadChunks]);

  if (dbInitError) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Enhanced Database Demo
          </CardTitle>
          <CardDescription className="text-xs text-red-600">
            Database failed to initialize
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-xs text-red-700 break-all" data-testid="db-init-error">
            {String(dbInitError.message || dbInitError)}
          </div>
          <div className="text-xs text-muted-foreground">
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
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Enhanced Database Demo
          </CardTitle>
          <CardDescription className="text-xs">Database is initializing...</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-32">
          <div className="text-sm text-muted-foreground">Loading PGlite database...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="database-demo-panel">
      <div className="p-4 border-b flex-shrink-0">
        <div className="text-sm font-medium flex items-center gap-2 mb-1">
          <Database className="h-4 w-4" />
          Enhanced Database Demo
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          PGlite WASM with pgvector, chunking, and embeddings
        </div>

        <SearchCollectionSelector
          db={dbContext}
          activeCollectionId={activeCollectionId}
          onCollectionChange={handleCollectionChange}
          onManageCollections={handleManageCollections}
          onCreateCollection={handleCreateCollection}
        />

        <DbInfoDisplay dbInfo={dbInfo} />

        <ViewSelector
          selectedView={selectedView}
          setSelectedView={setSelectedView}
          recordsCount={filteredRecords.length}
          chunksCount={filteredChunks.length}
        />

        {/* Settings Panel */}
        <div className="mb-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSettings(!showSettings)}
            className="h-6 px-2"
          >
            {showSettings ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Import Settings
          </Button>

          <div className={showSettings ? '' : 'hidden'}>
            <SettingsPanel importSettings={importSettings} />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            size="sm"
            onClick={importFlow.handleImportClick}
            disabled={importFlow.isImporting || !activeCollectionId}
            className="flex items-center gap-1"
            title={!activeCollectionId ? 'Select a collection first' : undefined}
          >
            <FileText className="h-3 w-3" />
            Import Selected Files ({importFlow.selectedFileCount})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportDropdown
            records={filteredRecords}
            chunks={filteredChunks}
            exportHandlers={exportHandlers}
          />
          <ClearDatabaseDialog
            clearAllData={clearAllData}
            records={records}
            chunks={chunks}
            clearing={clearing}
            showClearDialog={showClearDialog}
            setShowClearDialog={setShowClearDialog}
            onClear={handleClearDatabase}
          />
        </div>

        {importFlow.showImportProgress && importFlow.progress && (
          <div className="mt-4">
            <ImportProgressDisplay
              progress={importFlow.progress as EnhancedImportProgress}
              onClose={() => importFlow.setShowImportProgress(false)}
            />
          </div>
        )}

        {selectedView === 'search' && (
          <SearchInterface
            searchFunctionality={searchFunctionality}
            activeCollection={activeCollection}
            documentCount={documentCount}
          />
        )}
      </div>

      {/* Content Area - virtualized tables */}
      {(selectedView === 'files' || selectedView === 'chunks' || selectedView === 'search') && (
        <div className="px-4 pb-4">
          {selectedView === 'files' && (
            <div className="space-y-4">
              {/* Collection Context Header */}
              {activeCollection && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText className="h-4 w-4" />
                  <span>
                    Searching in: <strong>{activeCollection.name}</strong>
                  </span>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-4 w-4 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs">
                          Files need to be indexed with embeddings before you can search them. The
                          status below shows which files are searchable in your current collection.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              )}

              {!activeCollectionId ? (
                <div className="rounded-md border border-dashed bg-muted/20 p-4 text-center text-sm text-muted-foreground space-y-2">
                  <p>Select a collection above to see its files.</p>
                  {records.length === 0 && (
                    <p>
                      No files imported yet. Select files and click &quot;Import Selected
                      Files&quot; to get started.
                    </p>
                  )}
                </div>
              ) : (
                <FilesViewTable
                  records={filteredRecords}
                  expandedFiles={expandedFiles}
                  onToggleFileExpansion={toggleFileExpansion}
                  getFileChunks={getFileChunks}
                  activeCollectionName={activeCollection?.name ?? null}
                  fileStatuses={fileStatuses}
                />
              )}
            </div>
          )}

          {selectedView === 'chunks' &&
            (activeCollectionId ? (
              <ChunksViewTable
                chunks={filteredChunks}
                records={filteredRecords}
                pendingChunkIds={pendingChunkIds}
                activeCollectionId={activeCollectionId}
              />
            ) : (
              <div className="rounded-md border border-dashed bg-muted/20 p-4 text-center text-sm text-muted-foreground">
                Select a collection to inspect its chunks.
              </div>
            ))}

          {selectedView === 'search' && (
            <SearchViewTable
              searchFunctionality={searchFunctionality}
              activeCollectionName={activeCollection?.name}
            />
          )}
        </div>
      )}

      {/* Create Collection Dialog */}
      {createCollectionOpen && (
        <CreateEmbeddingSetDialog
          open={createCollectionOpen}
          onOpenChange={setCreateCollectionOpen}
          repository={embeddingSetsRepository}
          availableModels={availableModels}
          onSetCreated={(newSetId?: string) => {
            if (newSetId) {
              handleCollectionChange(newSetId);
            }
            setCreateCollectionOpen(false);
            // Reload collections (SearchCollectionSelector listens to event)
          }}
        />
      )}

      {/* Collection Management Dialog */}
      {manageCollectionsOpen && (
        <ManageEmbeddingSetsDialog
          open={manageCollectionsOpen}
          onOpenChange={setManageCollectionsOpen}
          db={dbContext as never}
          repository={embeddingSetsRepository}
          onSetSelected={(setId: string) => {
            handleCollectionChange(setId);
            setManageCollectionsOpen(false);
          }}
        />
      )}
    </div>
  );
}
