import {
  type EmbeddingSet,
  EmbeddingSetsRepository,
  useClearAllData,
  useDbProviderError,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
  usePGliteLiveQuery,
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
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import {
  CreateEmbeddingSetDialog,
  ManageEmbeddingSetsDialog,
} from '@brainstrike/vector-management';
import { ChevronDown, ChevronRight, Database, FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClearDatabaseDialog,
  CollectionBrowserView,
  DbInfoDisplay,
  ExportDropdown,
  ImportProgressDisplay,
  SearchCollectionSelector,
  SettingsPanel,
} from './components';
import { SemanticSearchProvider } from './contexts/semantic-search-context';
import {
  createImportCompletionHandler,
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
import { usePendingChunks } from './use-pending-chunks';
import { getActiveEmbeddingSetId, setActiveEmbeddingSetId } from './vector-preferences';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
}

const logger = createLogger('DatabaseDemoPanel');

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
  const [manageCollectionsOpen, setManageCollectionsOpen] = useState(false);
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    getActiveEmbeddingSetId()
  );

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

  // Live query for embedding sets (for CollectionBrowserView)
  // Using Record type to represent SQL row with snake_case column names from database schema
  type EmbeddingSetRow = Record<string, unknown> & {
    id: string;
    // biome-ignore lint/style/useNamingConvention: SQL column name
    model_key: string;
    // biome-ignore lint/style/useNamingConvention: SQL column name
    model_id: string;
    dimensions: number;
    distance: string;
    // biome-ignore lint/style/useNamingConvention: SQL column name
    created_at: string;
    name: string | null;
    description: string | null;
  };

  const { rows: embeddingSetRows, loading: embeddingSetsLoading } =
    usePGliteLiveQuery<EmbeddingSetRow>({
      query:
        'SELECT id, model_key, model_id, dimensions, distance, created_at, name, description FROM embedding_sets ORDER BY created_at DESC',
      enabled: Boolean(dbContext),
    });

  const embeddingSets = useMemo<EmbeddingSet[]>(() => {
    return embeddingSetRows.map((row) => {
      const set: EmbeddingSet = {
        id: row.id,
        modelKey: row.model_key,
        modelId: row.model_id,
        dimensions: row.dimensions,
        distance: row.distance as 'cosine' | 'l2' | 'ip',
        createdAt: row.created_at,
      };
      if (row.name) set.name = row.name;
      if (row.description) set.description = row.description;
      return set;
    });
  }, [embeddingSetRows]);

  // Get enabled models from preferences for Create dialog
  const { enabledModelsByProvider } = useEmbeddingPreferencesStore();
  const availableModels = useMemo(
    () => buildAvailableModelsFromPreferences(enabledModelsByProvider),
    [enabledModelsByProvider]
  );

  const showSettings = useDatabaseDemoStore((s) => s.showSettings);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);

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
  const handleCollectionChange = useCallback((collectionId: string | null) => {
    logger.info('Collection changed', { collectionId });
    setActiveCollectionId(collectionId);
    setActiveEmbeddingSetId(collectionId);
    logger.debug('Active embedding set after update', {
      activeEmbeddingSetId: getActiveEmbeddingSetId(),
    });
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
      </div>

      {/* Content Area - Collection Browser (unified hierarchical tree view) */}
      <div className="flex-1 overflow-hidden">
        <SemanticSearchProvider
          {...(semanticSearchExecutor ? { searchExecutor: semanticSearchExecutor } : {})}
        >
          <CollectionBrowserView
            embeddingSets={embeddingSets}
            records={records}
            chunks={chunks}
            pendingChunkIds={pendingChunkIds}
            activeCollectionId={activeCollectionId}
            isLoading={embeddingSetsLoading || refreshing}
            height="100%"
          />
        </SemanticSearchProvider>
      </div>

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
