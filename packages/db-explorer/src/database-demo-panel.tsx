import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { type EmbeddingSet, refreshCollectionIndexingStats } from '@brainstrike/db';
import {
  useClearAllData,
  useDbProviderError,
  useEmbeddingSetsRepository,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
} from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import type { QueueAdapter } from '@brainstrike/queue';
import { separatorClassName, useToast } from '@brainstrike/ui';
import { useEmbeddingControls } from '@brainstrike/vector-management';
import { Database } from 'lucide-react';
import { type ReactElement, type ReactNode, useCallback, useEffect, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ClearDatabaseDialog } from './components/clear-database-dialog';
import { CollectionBrowserView } from './components/collection-browser-view';
import { CreateCollectionDialog } from './components/create-collection-dialog';
import { DatabaseDemoCollectionDialogs } from './components/database-demo-collection-dialogs';
import { DatabaseDemoPrimaryPanel } from './components/database-demo-primary-panel';
import { SemanticSearchProvider, useSemanticSearch } from './contexts/semantic-search-context';
import { useCollectionDialogs } from './hooks/use-collection-dialogs';
import { useDatabaseClearAction } from './hooks/use-database-clear-action';
import { useDatabaseDemoActions } from './hooks/use-database-demo-actions';
import { useDatabaseDemoPagination } from './hooks/use-database-demo-pagination';
import { useDatabaseDemoTestHook } from './hooks/use-database-demo-test-hook';
import { useDatabaseErrorBoundary } from './hooks/use-database-error-boundary';
import { useEmbeddingQueueRegistration } from './hooks/use-embedding-queue-registration';
import { useExportHandlers } from './hooks/use-export-handlers';
import { useImportActivitySync } from './hooks/use-import-activity-sync';
import { createImportCompletionHandler } from './hooks/use-import-completion';
import { useImportFlowSettings } from './hooks/use-import-flow-settings';
import { useImportSettings } from './hooks/use-import-settings';
import { useSemanticSearchExecutor } from './hooks/use-semantic-search-executor';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import type { EnhancedImportResult } from './types';
import { useDatabaseDemoData } from './use-database-demo-data';
import type { UseImportFlowResult } from './use-import-flow';
import { useImportFlow } from './use-import-flow';
import { collectionCacheSnapshotFromEmbeddingSet } from './utils/collection-cache-snapshot';

interface DatabaseDemoPanelProps {
  embeddingQueue?: QueueAdapter | null;
  onDatabaseCleared: (() => void) | null;
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
          className="@container/database-toolbar h-9 shrink-0 border-b bg-background"
          data-testid="database-panel-toolbar"
        >
          <div className="flex h-full items-center justify-between @[360px]:gap-2 gap-1 @[360px]:px-4 px-2">
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
              <Database className="size-4 shrink-0" />
              <span className="@[360px]:inline hidden" data-testid="database-panel-loading-label">
                {failed ? 'Collections unavailable' : 'Collections'}
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
          className="flex h-9 shrink-0 items-center justify-center gap-2 border-t bg-background px-2"
          data-testid="database-panel-loading-actions"
        >
          <div className="h-7 w-10 rounded-md bg-muted/50" />
          <div className="size-7 rounded-md bg-muted/50" />
          <div className="h-7 w-14 rounded-md bg-muted/50" />
        </div>
      </div>
      <div aria-hidden="true" className="h-1 shrink-0 bg-border" />
      <div aria-hidden="true" className="min-h-0 flex-[62] border-t bg-background/35 p-4">
        <div className="h-full rounded-md border border-border/60 bg-muted/15" />
      </div>
    </>
  );
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
export function DatabaseDemoPanel({
  embeddingQueue = null,
  onDatabaseCleared,
}: DatabaseDemoPanelProps) {
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
  const setRecordPage = useDatabaseDemoStore((s) => s.setRecordPage);
  const setRecordPageSize = useDatabaseDemoStore((s) => s.setRecordPageSize);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);

  const importSettings = useImportSettings();
  const [chunkRepository, setChunkRepository] =
    useState<UseImportFlowResult['chunkRepository']>(null);
  const resolveActiveCollectionId = useCallback(() => activeCollectionId, [activeCollectionId]);

  // Read import state from Zustand store (shared with VectorStatus for query pausing)
  const isImportActive = useImportActivitySync();
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
  useDatabaseDemoPagination({
    activeCollectionId,
    totalPages: recordPagination.totalPages,
  });

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

  const importFlowSettings = useImportFlowSettings(importSettings);

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

  useEmbeddingQueueRegistration(embeddingQueue);
  useDatabaseDemoTestHook({
    activeCollectionId,
    isImporting: importFlow.isImporting,
    progress: importFlow.progress,
    recordCount: records.length,
    recordCurrentPage: recordPagination.currentPage,
    recordPageSize: recordPagination.pageSize,
    recordTotalRecords: recordPagination.totalRecords,
    selectedFileCount: importFlow.selectedFileCount,
  });

  const handleClearDatabase = useDatabaseClearAction({
    clearAllData,
    errorBoundary,
    loadChunks,
    loadRecords,
    onDatabaseCleared,
    setClearing,
    setShowClearDialog,
    toast,
  });

  const { handleCollectionChange, handleManualRefresh } = useDatabaseDemoActions({
    loadChunks,
    loadRecords,
    setActiveCollectionId,
  });

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
          <DatabaseDemoPrimaryPanel
            activeCollectionCounts={activeCollectionCounts}
            activeCollectionCountsPending={activeCollectionCountsPending}
            activeCollectionId={activeCollectionId}
            clearAllData={clearAllData}
            clearing={clearing}
            collectionCountsStatus={collectionCountsStatus}
            collectionDialogs={collectionDialogs}
            dbContext={dbContext}
            dropdownProps={dropdownProps}
            exportHandlers={exportHandlers}
            importFlow={importFlow}
            importSettings={importSettings}
            isManagedCollection={isManagedCollection}
            onClearDatabase={handleClearDatabase}
            onCollectionChange={handleCollectionChange}
            onManualRefresh={handleManualRefresh}
            refreshing={refreshing}
            setShowClearDialog={setShowClearDialog}
            setShowSettings={setShowSettings}
            showClearDialog={showClearDialog}
            showSettings={showSettings}
          />
        </Panel>

        <Separator
          aria-label="Resize database panels"
          className={separatorClassName({ orientation: 'vertical' })}
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

      {/* Clear Database dialog - triggered from Import Settings */}
      <ClearDatabaseDialog
        chunksCount={activeCollectionCounts.chunks}
        clearing={clearing}
        countsPending={activeCollectionCountsPending}
        onClear={handleClearDatabase}
        recordsCount={activeCollectionCounts.records}
        setShowClearDialog={setShowClearDialog}
        showClearDialog={showClearDialog}
      />

      <DatabaseDemoCollectionDialogs
        activeCollectionId={activeCollectionId}
        collectionDialogs={collectionDialogs}
        createDialog={
          collectionDialogs.createCollectionOpen ? (
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
          ) : null
        }
        dbContext={dbContext}
        embeddingSetsRepository={embeddingSetsRepository}
        onActiveCollectionDeleted={() => setActiveCollectionId(null)}
      />
    </DatabasePanelFrame>
  );
}
