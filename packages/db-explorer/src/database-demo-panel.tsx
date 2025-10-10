import {
  useClearAllData,
  useDbProviderError,
  useFactoryReset,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  useToast,
} from '@brainstrike/ui';
import { ChevronDown, ChevronRight, Database, FileText, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChunksViewTable,
  ClearDatabaseDialog,
  DbInfoDisplay,
  ExportDropdown,
  FilesViewTable,
  ImportProgressDisplay,
  SearchInterface,
  SearchViewTable,
  SettingsPanel,
  ViewSelector,
} from './components';
import {
  createImportCompletionHandler,
  useDatabaseErrorBoundary,
  useExportHandlers,
  useImportSettings,
  useSearchFunctionality,
} from './hooks';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportProgress, EnhancedImportResult } from './types';
import { useDatabaseDemoData } from './use-database-demo-data';
import { useEmbeddingService } from './use-embedding-service';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';
import { usePendingChunks } from './use-pending-chunks';
import { getActiveEmbeddingSetId } from './vector-preferences';

export function DatabaseDemoPanel() {
  const repository = useFileRecordRepository();
  const dbInitError = useDbProviderError();
  const clearAllData = useClearAllData();
  const dbContext = usePGliteDatabase();
  const doFactoryReset = useFactoryReset();
  const { toast } = useToast();
  const errorBoundary = useDatabaseErrorBoundary({
    toast,
    onError: (error) => {
      console.error('Database operation error:', error);
    },
  });

  const [clearing, setClearing] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
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

  const data = useDatabaseDemoData({
    repository,
    chunkRepository,
    toast,
    database: dbContext,
  });
  const { records, chunks, refreshing, dbInfo, loadRecords, loadChunks } = data;

  const { pendingChunkIds } = usePendingChunks({
    database: dbContext,
    resolveActiveSetId: getActiveEmbeddingSetId,
  });

  const { service: embeddingService, dispose: disposeEmbeddingService } = useEmbeddingService({
    enableEmbedding: importSettings.enableEmbedding,
    model: importSettings.selectedModel ?? null,
  });

  const exportHandlers = useExportHandlers(data.records, data.chunks, toast);

  const searchFunctionality = useSearchFunctionality(
    embeddingService,
    chunkRepository,
    repository,
    importSettings.selectedModel,
    toast
  );

  // Seed search state from persistence on first mount
  useEffect(() => {
    if (persistedSearchQuery && persistedSearchQuery !== searchFunctionality.searchQuery) {
      searchFunctionality.setSearchQuery(persistedSearchQuery);
    }
    if (
      Number.isFinite(persistedThreshold) &&
      persistedThreshold !== searchFunctionality.searchThreshold
    ) {
      searchFunctionality.setSearchThreshold(persistedThreshold);
    }
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
      enableEmbedding: importSettings.enableEmbedding,
      selectedModel: importSettings.selectedModel ?? null,
      chunkSize: importSettings.chunkSize,
      chunkOverlap: importSettings.chunkOverlap,
    }),
    [
      importSettings.enableChunking,
      importSettings.chunkingStrategy,
      importSettings.enableEmbedding,
      importSettings.selectedModel,
      importSettings.chunkSize,
      importSettings.chunkOverlap,
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
  });

  useEffect(() => {
    const handler = () => {
      void loadChunks();
    };
    window.addEventListener('brainstrike:queue-drained', handler as EventListener);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handler as EventListener);
    };
  }, [loadChunks]);

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

  const safeDisposeEmbeddingService = useCallback(async () => {
    await disposeEmbeddingService();
  }, [disposeEmbeddingService]);

  const clearActiveEmbeddingSetId = useCallback(() => {
    try {
      localStorage.removeItem('brainstrike.activeEmbeddingSetId');
    } catch (err) {
      console.warn('Failed to clear active embedding set id:', err);
    }
  }, []);

  const bestEffortPurgeDb = useCallback(async () => {
    if (!dbContext) return;
    try {
      await dbContext.query('DELETE FROM job_queue');
    } catch (err) {
      console.warn('Failed to purge job_queue during factory reset:', err);
    }
    try {
      await dbContext.query('DELETE FROM embedding_sets');
    } catch (err) {
      console.warn('Failed to purge embedding_sets during factory reset:', err);
    }
  }, [dbContext]);

  const performFactoryResetOrReload = useCallback(async () => {
    try {
      if (typeof doFactoryReset === 'function') {
        await doFactoryReset();
      } else {
        window.location.reload();
      }
    } catch (err) {
      console.warn('Provider-level factory reset failed, reloading window:', err);
      try {
        window.location.reload();
      } catch (e) {
        console.warn('Window reload after provider-level reset failed:', e);
      }
    }
  }, [doFactoryReset]);

  const handleFactoryResetClick = useCallback(async () => {
    const ok = window.confirm(
      'Factory Reset will wipe all data (files, chunks, embedding sets, job queue), dispose embeddings, and reload the database. Continue?'
    );
    if (!ok) return;
    try {
      await safeDisposeEmbeddingService();
      clearActiveEmbeddingSetId();
      await bestEffortPurgeDb();
      await performFactoryResetOrReload();
    } catch (err) {
      toast({
        title: 'Factory Reset Failed',
        description: String(err),
        variant: 'destructive',
      });
    }
  }, [
    safeDisposeEmbeddingService,
    clearActiveEmbeddingSetId,
    bestEffortPurgeDb,
    performFactoryResetOrReload,
    toast,
  ]);

  const toggleFileExpansion = useCallback(
    (fileId: string) => {
      if (expandedFiles.has(fileId)) removeExpanded(fileId);
      else addExpanded(fileId);
    },
    [expandedFiles, addExpanded, removeExpanded]
  );

  const getFileChunks = useCallback(
    (fileId: string) => data.chunks.filter((chunk) => chunk.fileRecordId === fileId),
    [data.chunks]
  );

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

        <DbInfoDisplay dbInfo={dbInfo} />

        <ViewSelector
          selectedView={selectedView}
          setSelectedView={setSelectedView}
          recordsCount={records.length}
          chunksCount={chunks.length}
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
            disabled={importFlow.isImporting}
            className="flex items-center gap-1"
          >
            <FileText className="h-3 w-3" />
            Import Selected Files ({importFlow.selectedFileCount})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void loadRecords();
              void loadChunks();
            }}
            disabled={refreshing}
            className="flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <ExportDropdown records={records} chunks={chunks} exportHandlers={exportHandlers} />
          <ClearDatabaseDialog
            clearAllData={clearAllData}
            records={records}
            chunks={chunks}
            clearing={clearing}
            showClearDialog={showClearDialog}
            setShowClearDialog={setShowClearDialog}
            onClear={handleClearDatabase}
          />
          <Button size="sm" variant="destructive" onClick={handleFactoryResetClick}>
            Factory Reset
          </Button>
        </div>

        {importFlow.showImportProgress && importFlow.progress && (
          <div className="mt-4">
            <ImportProgressDisplay
              progress={importFlow.progress as EnhancedImportProgress}
              onClose={() => importFlow.setShowImportProgress(false)}
            />
          </div>
        )}

        {selectedView === 'search' && <SearchInterface searchFunctionality={searchFunctionality} />}
      </div>

      {/* Content Area - virtualized tables */}
      {(selectedView === 'files' || selectedView === 'chunks' || selectedView === 'search') && (
        <div className="px-4 pb-4">
          {selectedView === 'files' && (
            <FilesViewTable
              records={records}
              expandedFiles={expandedFiles}
              onToggleFileExpansion={toggleFileExpansion}
              getFileChunks={getFileChunks}
            />
          )}

          {selectedView === 'chunks' && (
            <ChunksViewTable chunks={chunks} records={records} pendingChunkIds={pendingChunkIds} />
          )}

          {selectedView === 'search' && (
            <SearchViewTable searchFunctionality={searchFunctionality} />
          )}
        </div>
      )}
    </div>
  );
}
