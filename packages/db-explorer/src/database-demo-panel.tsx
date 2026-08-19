import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { EmbeddingSet } from '@brainstrike/db';
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
import { useToast } from '@brainstrike/ui';
import { useEmbeddingControls } from '@brainstrike/vector-management';
import { Database } from 'lucide-react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { ClearDatabaseDialog } from './components/clear-database-dialog';
import { CollectionDebugDrawer } from './components/collection-debug-drawer';
import { CreateCollectionDialog } from './components/create-collection-dialog';
import { DatabaseDemoCollectionDialogs } from './components/database-demo-collection-dialogs';
import { DatabaseDemoPrimaryPanel } from './components/database-demo-primary-panel';
import { useCollectionDialogs } from './hooks/use-collection-dialogs';
import { useDatabaseClearAction } from './hooks/use-database-clear-action';
import { useDatabaseDemoActions } from './hooks/use-database-demo-actions';
import { useDatabaseDemoPagination } from './hooks/use-database-demo-pagination';
import { useDatabaseDemoTestHook } from './hooks/use-database-demo-test-hook';
import { useDatabaseErrorBoundary } from './hooks/use-database-error-boundary';
import { useEmbeddingQueueRegistration } from './hooks/use-embedding-queue-registration';
import { useExportHandlers } from './hooks/use-export-handlers';
import { useImportActivitySync } from './hooks/use-import-activity-sync';
import { useImportSettings } from './hooks/use-import-settings';
import { useIsManagedCollection } from './hooks/use-is-managed-collection';
import { useDatabaseDemoStore } from './stores/database-demo-store';
import { useDatabaseDemoData } from './use-database-demo-data';
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
    <div className="flex min-h-0 flex-1 flex-col" data-testid="database-panel-loading-top">
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
          className={failed ? 'max-w-md text-destructive text-xs' : 'text-muted-foreground text-xs'}
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
  );
}

const logger = createLogger('DatabaseDemoPanel');

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
  // The debug drawer refuses a managed workspace-index collection for its
  // scored preview, and that refusal has to name a reason — so it needs the
  // role, not just the id.
  const activeCollectionSystemRole = useVectorStatusUIStore((state) => {
    const collection = state.cachedCollections.find(
      (candidate) => candidate.id === activeCollectionId
    );
    return collection?.systemRole ?? null;
  });
  const setActiveCollectionId = useVectorStatusUIStore((s) => s.setActiveEmbeddingSetId);
  const upsertCachedCollection = useVectorStatusUIStore((s) => s.upsertCachedCollection);
  const isManagedCollection = useIsManagedCollection();

  // Get embedding sets repository from DbProvider (Drizzle-based)
  const embeddingSetsRepository = useEmbeddingSetsRepository();

  const showSettings = useDatabaseDemoStore((s) => s.showSettings);
  const recordPage = useDatabaseDemoStore((s) => s.recordPage);
  const recordPageSize = useDatabaseDemoStore((s) => s.recordPageSize);
  const setRecordPage = useDatabaseDemoStore((s) => s.setRecordPage);
  const setShowSettings = useDatabaseDemoStore((s) => s.setShowSettings);

  const importSettings = useImportSettings();

  // Read import state from Zustand store (shared with VectorStatus for query pausing)
  const isImportActive = useImportActivitySync();
  const isEmbeddingActive = useVectorStatusUIStore((s) => s.isEmbeddingActive);

  const data = useDatabaseDemoData({
    activeCollectionId,
    chunkRepository: dbChunkRepository,
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
    getTestCacheDiagnostics,
    records,
    refreshing,
    loadRecords,
    loadChunks,
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

  // Embedding controls state for the action dropdown. Canonical queue/activity
  // status is rendered by the shared app-shell status bar.
  const { dropdownProps } = useEmbeddingControls({
    chunkRepository: dbChunkRepository,
    toast,
  });

  useEmbeddingQueueRegistration(embeddingQueue);
  // Import progress comes from whichever surface is running the import (the
  // explorer's selection bar), not from a duplicate service mounted here.
  useDatabaseDemoTestHook({
    activeCollectionId,
    getCacheDiagnostics: getTestCacheDiagnostics,
    isImporting: isImportActive,
    recordCount: records.length,
    recordCurrentPage: recordPagination.currentPage,
    recordPageSize: recordPagination.pageSize,
    records,
    recordTotalRecords: recordPagination.totalRecords,
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

      {/* Debug affordances preserved from the retired Collection Browser
          (BST-1214). Collapsed by default and lazily mounted, so this costs a
          single button until it is opened. It reads the file page the live
          query above already holds rather than opening a second subscription. */}
      <CollectionDebugDrawer
        activeCollectionId={activeCollectionId}
        activeCollectionSystemRole={activeCollectionSystemRole}
        chunkRepository={dbChunkRepository}
        database={dbContext}
        fileRepository={repository}
        onRecordPageChange={setRecordPage}
        recordPagination={recordPagination}
        records={records}
      />

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
