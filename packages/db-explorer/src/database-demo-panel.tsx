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
import { useModelRegistryStore, useVectorStatusUIStore } from '@brainstrike/preferences';
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
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  ClearDatabaseDialog,
  CollectionBrowserView,
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

type DatabaseDemoPanelProps = {
  embeddingQueue?: QueueAdapter | null;
};

const logger = createLogger('DatabaseDemoPanel');

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
  // Use Zustand store directly as single source of truth for collection selection
  const activeCollectionId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const setActiveCollectionId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);

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

  const embeddingSets = useMemo<EmbeddingSet[]>(
    () =>
      embeddingSetRows.map((row) => {
        const set: EmbeddingSet = {
          id: row.id,
          modelKey: row.model_key,
          modelId: row.model_id,
          dimensions: row.dimensions,
          distance: row.distance as 'cosine' | 'l2' | 'ip',
          createdAt: row.created_at,
        };
        if (row.name) {
          set.name = row.name;
        }
        if (row.description) {
          set.description = row.description;
        }
        return set;
      }),
    [embeddingSetRows]
  );

  // Get enabled models from model registry
  const { models, providers, fetchRegistry, isLoading: modelsLoading } = useModelRegistryStore();

  // biome-ignore lint/plugin: Legitimate data loading pattern - fetch registry when db becomes available
  useEffect(() => {
    if (dbContext) {
      void fetchRegistry(dbContext);
    }
  }, [dbContext, fetchRegistry]);
  const availableModels = useMemo(
    () =>
      models
        .filter((m) => m.isEnabled && m.capabilities.type === 'embedding')
        .map((m) => ({
          id: m.providerId === 'local' ? m.id : `${m.providerId}::${m.id}`,
          providerId: m.providerId,
          name: m.name,
          description: m.description,
          capabilities: m.capabilities,
          ...(m.parameters && 'pricePer1MTokens' in m.parameters
            ? {
                pricePer1MTokensInput: (m.parameters as { pricePer1MTokens: number })
                  .pricePer1MTokens,
              }
            : {}),
        })),
    [models]
  );

  const availableProviders = useMemo(
    () =>
      providers
        .filter((p) => p.isEnabled)
        .map((p) => ({
          id: p.id,
          name: p.name,
          icon: p.icon,
        })),
    [providers]
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

  const { pendingChunkIds } = usePendingChunks({
    database: dbContext,
    resolveActiveSetId: resolveActiveCollectionId,
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
  const handleCollectionChange = useCallback(
    (collectionId: string | null) => {
      logger.info('Collection changed', { collectionId });
      setActiveCollectionId(collectionId);
    },
    [setActiveCollectionId]
  );

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
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="h-4 w-4" />
            Enhanced Database Demo
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
            Enhanced Database Demo
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
          <div className="flex h-full flex-col gap-3 overflow-auto px-4 py-3">
            <div>
              <div className="mb-1 flex items-center gap-2 font-medium text-sm">
                <Database className="h-4 w-4" />
                Enhanced Database Demo
              </div>
              <div className="text-muted-foreground text-xs">
                PGlite WASM with pgvector, chunking, and embeddings
              </div>
            </div>

            <SearchCollectionSelector
              activeCollectionId={activeCollectionId}
              db={dbContext}
              onCollectionChange={handleCollectionChange}
              onCreateCollection={handleCreateCollection}
              onManageCollections={handleManageCollections}
            />

            {/* Settings Panel */}
            <div>
              <Button
                className="h-6 px-2"
                onClick={() => setShowSettings(!showSettings)}
                size="sm"
                variant="ghost"
              >
                {showSettings ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                Import Settings
              </Button>

              <div className={showSettings ? '' : 'hidden'}>
                <SettingsPanel
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
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                className="flex items-center gap-1"
                disabled={
                  importFlow.isImporting ||
                  !activeCollectionId ||
                  importFlow.selectedFileCount === 0
                }
                onClick={importFlow.handleImportClick}
                size="sm"
                title={
                  importFlow.selectedFileCount === 0
                    ? 'Select files to import first'
                    : activeCollectionId
                      ? undefined
                      : 'Select a collection first'
                }
              >
                <FileText className="h-3 w-3" />
                Import Selected Files ({importFlow.selectedFileCount})
              </Button>
              <Button
                className="flex items-center gap-1"
                disabled={refreshing}
                onClick={handleManualRefresh}
                size="sm"
                variant="outline"
              >
                <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <ExportDropdown
                chunks={filteredChunks}
                exportHandlers={exportHandlers}
                records={filteredRecords}
              />
            </div>

            {importFlow.showImportProgress && importFlow.progress && (
              <ImportProgressDisplay
                onClose={() => importFlow.setShowImportProgress(false)}
                progress={importFlow.progress as EnhancedImportProgress}
              />
            )}
          </div>
        </Panel>

        <PanelResizeHandle className="h-1 bg-border/60 transition-colors hover:bg-border" />

        <Panel className="min-h-0" defaultSize={62} minSize={30}>
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <SemanticSearchProvider
              {...(semanticSearchExecutor ? { searchExecutor: semanticSearchExecutor } : {})}
            >
              <CollectionBrowserView
                activeCollectionId={activeCollectionId}
                chunks={chunks}
                embeddingSets={embeddingSets}
                height="100%"
                isLoading={embeddingSetsLoading || refreshing}
                pendingChunkIds={pendingChunkIds}
                records={records}
              />
            </SemanticSearchProvider>
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
      {createCollectionOpen && (
        <CreateEmbeddingSetDialog
          isLoading={modelsLoading}
          models={availableModels}
          onOpenChange={setCreateCollectionOpen}
          onSetCreated={(newSetId?: string) => {
            if (newSetId) {
              handleCollectionChange(newSetId);
            }
            setCreateCollectionOpen(false);
            // Reload collections (SearchCollectionSelector listens to event)
          }}
          open={createCollectionOpen}
          providers={availableProviders}
          repository={embeddingSetsRepository}
        />
      )}

      {/* Collection Management Dialog */}
      {manageCollectionsOpen && (
        <ManageEmbeddingSetsDialog
          db={dbContext as never}
          onOpenChange={setManageCollectionsOpen}
          onSetSelected={(setId: string) => {
            handleCollectionChange(setId);
            setManageCollectionsOpen(false);
          }}
          open={manageCollectionsOpen}
          repository={embeddingSetsRepository}
        />
      )}
    </div>
  );
}
