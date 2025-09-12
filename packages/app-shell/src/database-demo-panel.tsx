import type { FileChunk, FileRecord } from '@brainstrike/db';
import {
  useClearAllData,
  useDbProviderError,
  useFactoryReset,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import { useFileExplorer, useSelectionManager } from '@brainstrike/file-explorer-ui';
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
import type { EnhancedImportProgress } from './database-demo';
import {
  ChunksView,
  ClearDatabaseDialog,
  createImportCompletionHandler,
  DbInfoDisplay,
  ExportButtons,
  FilesView,
  ImportProgressDisplay,
  SearchInterface,
  SearchView,
  SettingsPanel,
  useDatabaseErrorBoundary,
  useExportHandlers,
  useImportSettings,
  useSearchFunctionality,
  ViewSelector,
} from './database-demo';
import { useEnhancedFileImportService } from './enhanced-file-import-service';
import { useDatabaseDemoStore } from './stores/database-demo-store';
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
      // Log critical errors for monitoring in production
      console.error('Database operation error:', error);
    },
  });

  // State
  const [records, setRecords] = useState<FileRecord[]>([]);
  const [chunks, setChunks] = useState<FileChunk[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showImportProgress, setShowImportProgress] = useState(false);
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
  const [embeddingService, setEmbeddingService] = useState<SimpleEmbeddingService | null>(null);
  const [dbInfo, setDbInfo] = useState<{
    location: string;
    testResult: string;
    connected: boolean;
  } | null>(null);
  const [pendingChunkIds, setPendingChunkIds] = useState<Set<string>>(new Set());
  const db = usePGliteDatabase();

  // Custom hooks
  const importSettings = useImportSettings();
  const exportHandlers = useExportHandlers(records, chunks, toast);

  // File explorer and selection
  const { fileContents, fileTree } = useFileExplorer();
  const { selectedFilePaths } = useSelectionManager({
    onSelectionLimitExceeded: () => {
      toast({
        title: 'Selection Limit Reached',
        description: 'You have reached the maximum number of files that can be selected.',
        variant: 'destructive',
      });
    },
  });

  // Enhanced file import service
  const { isImporting, progress, importFiles, chunkRepository } = useEnhancedFileImportService({
    onProgress: () => setShowImportProgress(true),
    onComplete: (results) => {
      const handler = createImportCompletionHandler(toast, loadRecords, () => {
        if (chunkRepository) return loadChunks();
        return Promise.resolve();
      });
      handler(results);
    },
    onError: (error) => {
      toast({
        title: 'Import Failed',
        description: error.message,
        variant: 'destructive',
      });
    },
    enableChunking: importSettings.enableChunking,
    chunkingStrategy: importSettings.chunkingStrategy,
    enableEmbedding: importSettings.enableEmbedding,
    embeddingModel: importSettings.selectedModel,
    chunkSize: importSettings.chunkSize,
    chunkOverlap: importSettings.chunkOverlap,
  });

  // Search functionality
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

  // Keep persisted values in sync with live search state
  useEffect(() => {
    setSearchQueryPersist(searchFunctionality.searchQuery);
  }, [searchFunctionality.searchQuery, setSearchQueryPersist]);
  useEffect(() => {
    setSearchThresholdPersist(searchFunctionality.searchThreshold);
  }, [searchFunctionality.searchThreshold, setSearchThresholdPersist]);

  // Initialize embedding service
  useEffect(() => {
    if (importSettings.enableEmbedding && importSettings.selectedModel) {
      const service = new SimpleEmbeddingService();
      setEmbeddingService(service);
      return () => service.dispose();
    }
    return () => {};
  }, [importSettings.enableEmbedding, importSettings.selectedModel]);

  // Data loading functions
  const loadRecords = useCallback(async () => {
    if (!repository) return;

    try {
      setRefreshing(true);
      const importedRecords =
        (await repository.findAllWithContent?.()) || (await repository.findAll());
      setRecords(importedRecords);
    } catch (_error) {
      toast({
        title: 'Error',
        description: 'Failed to load database records',
        variant: 'destructive',
      });
    } finally {
      setRefreshing(false);
    }
  }, [repository, toast]);

  const loadChunks = useCallback(async () => {
    if (!chunkRepository) return;

    try {
      const allChunks = await chunkRepository.findAll();
      setChunks(allChunks);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      if (!errorMessage.includes('vector') && !errorMessage.includes('chunks')) {
        toast({
          title: 'Error',
          description: 'Failed to load chunks',
          variant: 'destructive',
        });
      }
      setChunks([]);
    }
  }, [chunkRepository, toast]);

  // Poll queued/running jobs to mark pending chunks for the active set
  useEffect(() => {
    let canceled = false;
    if (!db) return;
    const activeSetId = getActiveEmbeddingSetId() ?? null;
    if (!activeSetId) return;
    const fetchPending = async () => {
      try {
        const res = await db.query<{ dedupeKey: string | null }>(
          "SELECT dedupe_key AS \"dedupeKey\" FROM job_queue WHERE queue = 'embeddings' AND state IN ('queued','running')"
        );
        const ids = new Set(
          res.rows
            .map((r) => (r.dedupeKey ?? '').split(':'))
            .filter((p) => p.length >= 2 && p[1] === activeSetId && p[0])
            .map((p) => p[0] as string)
        );
        if (!canceled) setPendingChunkIds(ids);
      } catch {
        // ignore HUD errors
      }
    };
    void fetchPending();
    const id = setInterval(fetchPending, 2000);
    return () => {
      canceled = true;
      clearInterval(id);
    };
  }, [db]);

  const testDatabaseConnection = useCallback(async () => {
    if (!repository) {
      setDbInfo({
        location: 'Unknown',
        testResult: 'Repository not available',
        connected: false,
      });
      return;
    }

    try {
      const testResult = await repository.count();
      setDbInfo({
        location: 'Database connected via DbProvider',
        testResult: `Successfully connected - ${testResult} file records found`,
        connected: true,
      });
    } catch (error) {
      setDbInfo({
        location: 'Unknown',
        testResult: `Database connection failed: ${error}`,
        connected: false,
      });
    }
  }, [repository]);

  // Initialize data
  useEffect(() => {
    // Fast-path: if running in Electron with IPC, test connectivity directly
    try {
      // biome-ignore lint/suspicious/noExplicitAny: window API comes from preload
      const w = window as any;
      const hasIpcPing = typeof w !== 'undefined' && w?.electronAPI?.db?.ping;
      if (hasIpcPing) {
        void (async () => {
          try {
            const res = await w.electronAPI.db.ping();
            if (res?.success) {
              setDbInfo({
                location: 'Main Process',
                testResult: 'connected',
                connected: true,
              });
            }
          } catch (_e) {
            // noop
          }
        })();
      }
      const hasIpcTest = typeof w !== 'undefined' && w?.electronAPI?.db?.test;
      if (hasIpcTest) {
        void (async () => {
          try {
            const res = await w.electronAPI.db.test();
            if (res?.success) {
              setDbInfo({
                location: 'Main Process',
                testResult: 'Connected (IPC)',
                connected: true,
              });
            }
          } catch (_e) {
            // noop, repository-based test below will set proper state
          }
        })();
      }
    } catch (_err) {
      // ignore
    }

    if (repository) {
      void loadRecords();
      void testDatabaseConnection();
    }
    if (chunkRepository) {
      void loadChunks();
    }
  }, [repository, chunkRepository, loadRecords, loadChunks, testDatabaseConnection]);

  // Auto-refresh chunks when queue drains for embeddings
  useEffect(() => {
    const handler = () => {
      if (chunkRepository) void loadChunks();
    };
    window.addEventListener('brainstrike:queue-drained', handler as EventListener);
    return () => {
      window.removeEventListener('brainstrike:queue-drained', handler as EventListener);
    };
  }, [chunkRepository, loadChunks]);

  // Event handlers
  const handleImportClick = useCallback(() => {
    if (selectedFilePaths.size === 0) {
      toast({
        title: 'No Files Selected',
        description: 'Please select files in the explorer before importing.',
        variant: 'destructive',
      });
      return;
    }
    void importFiles(selectedFilePaths, fileTree, fileContents);
  }, [selectedFilePaths, fileTree, fileContents, importFiles, toast]);

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

    // Use error boundary with multiple operations for comprehensive error handling
    await errorBoundary.executeMultipleOperations(
      [
        {
          operation: async () => {
            const clearResult = await clearAllData();
            return clearResult;
          },
          name: 'Clear Database',
          critical: true, // If clear fails, don't try to reload data
        },
        {
          operation: async () => {
            await loadRecords();
            return { deletedFiles: 0, deletedChunks: 0 };
          },
          name: 'Reload File Records',
          critical: false,
        },
        ...(chunkRepository
          ? [
              {
                operation: async () => {
                  await loadChunks();
                  return { deletedFiles: 0, deletedChunks: 0 };
                },
                name: 'Reload Chunks',
                critical: false,
              },
            ]
          : []),
      ],
      setClearing,
      {
        successTitle: 'Database Cleared',
        successMessage: 'Database has been cleared and data reloaded successfully',
        partialSuccessTitle: 'Database Cleared',
        partialSuccessMessage: 'Database was cleared but some data reload operations failed',
      }
    );
  }, [clearAllData, toast, loadRecords, loadChunks, chunkRepository, errorBoundary]);

  // Factory reset helpers (extracted to reduce inline complexity)
  const safeDisposeEmbeddingService = useCallback(async () => {
    if (!embeddingService) return;
    try {
      await embeddingService.dispose();
    } catch (err) {
      // Log for diagnostics; UI will handle toast on outer error
      console.warn('Failed to dispose embedding service during factory reset:', err);
    }
    setEmbeddingService(null);
  }, [embeddingService]);

  const clearActiveEmbeddingSetId = () => {
    try {
      localStorage.removeItem('brainstrike.activeEmbeddingSetId');
    } catch (err) {
      console.warn('Failed to clear active embedding set id:', err);
    }
  };

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
  }, [safeDisposeEmbeddingService, bestEffortPurgeDb, performFactoryResetOrReload, toast]);

  const toggleFileExpansion = useCallback(
    (fileId: string) => {
      if (expandedFiles.has(fileId)) removeExpanded(fileId);
      else addExpanded(fileId);
    },
    [expandedFiles, addExpanded, removeExpanded]
  );

  const getFileChunks = useCallback(
    (fileId: string) => chunks.filter((chunk) => chunk.fileRecordId === fileId),
    [chunks]
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
    <div className="h-full flex flex-col" data-testid="database-demo-panel">
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
        <div className="flex gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleImportClick}
            disabled={isImporting}
            className="flex items-center gap-1"
          >
            <FileText className="h-3 w-3" />
            Import Selected Files ({selectedFilePaths.size})
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void loadRecords();
              if (chunkRepository) void loadChunks();
            }}
            disabled={refreshing}
            className="flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
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

        <ExportButtons records={records} chunks={chunks} exportHandlers={exportHandlers} />

        {showImportProgress && progress && (
          <div className="mt-4">
            <ImportProgressDisplay
              progress={progress as EnhancedImportProgress}
              onClose={() => setShowImportProgress(false)}
            />
          </div>
        )}

        {selectedView === 'search' && <SearchInterface searchFunctionality={searchFunctionality} />}
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="p-4 h-full">
          {selectedView === 'files' && (
            <FilesView
              records={records}
              expandedFiles={expandedFiles}
              onToggleFileExpansion={toggleFileExpansion}
              getFileChunks={getFileChunks}
            />
          )}

          {selectedView === 'chunks' && (
            <ChunksView chunks={chunks} records={records} pendingChunkIds={pendingChunkIds} />
          )}

          {selectedView === 'search' && <SearchView searchFunctionality={searchFunctionality} />}
        </div>
      </div>
    </div>
  );
}
