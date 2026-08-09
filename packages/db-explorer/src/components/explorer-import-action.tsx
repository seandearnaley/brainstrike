import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { type EmbeddingSet, refreshCollectionIndexingStats } from '@brainstrike/db';
import { useEmbeddingSetsRepository, usePGliteDatabase } from '@brainstrike/db/react';
import { useSelectionActionBarPin } from '@brainstrike/file-explorer-ui/shell';
import type { QueueAdapter } from '@brainstrike/queue';
import { Button, Popover, PopoverContent, PopoverTrigger, useToast } from '@brainstrike/ui';
import { FileText } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useCollectionDialogs } from '../hooks/use-collection-dialogs';
import { createImportCompletionHandler } from '../hooks/use-import-completion';
import { useImportFlowSettings } from '../hooks/use-import-flow-settings';
import { useImportSettings } from '../hooks/use-import-settings';
import {
  clearImportActivitySnapshot,
  publishImportActivitySnapshot,
} from '../import-activity-snapshot';
import type { EnhancedImportProgress, EnhancedImportResult } from '../types';
import { useImportFlow } from '../use-import-flow';
import { collectionCacheSnapshotFromEmbeddingSet } from '../utils/collection-cache-snapshot';
import { CreateCollectionDialog } from './create-collection-dialog';
import { DatabaseDemoCollectionDialogs } from './database-demo-collection-dialogs';
import { ExplorerCollectionPicker } from './explorer-collection-picker';
import { ImportProgressBar } from './import-progress-bar';

const MANAGED_COLLECTION_BLOCK_REASON = 'Background indexing manages imports for this collection';

export interface ExplorerImportActionProps {
  /**
   * The app-owned embedding queue. Imports still succeed without it, but the
   * chunks they produce are never handed to the embedding producer, so callers
   * must supply the same queue the rest of the app uses.
   */
  readonly embeddingQueue?: QueueAdapter | null;
}

function resolveImportBlockReason({
  activeCollectionId,
  isImporting,
  isManagedCollection,
  selectedFileCount,
}: {
  activeCollectionId: string | null;
  isImporting: boolean;
  isManagedCollection: boolean;
  selectedFileCount: number;
}): string | null {
  if (selectedFileCount === 0) {
    return 'Select files to import first';
  }
  if (isManagedCollection) {
    return MANAGED_COLLECTION_BLOCK_REASON;
  }
  if (!activeCollectionId) {
    return 'Select a collection first';
  }
  if (isImporting) {
    return 'An import is already running';
  }
  return null;
}

/**
 * The explorer's "Import into collection…" selection action.
 *
 * It lives in the explorer's selection action bar because that is where the
 * selection it operates on lives; the picker, the create/rename/delete dialog
 * host and the import machinery all mount behind the popover, so nothing here
 * subscribes to collection data while the bar is closed.
 */
export function ExplorerImportAction({
  embeddingQueue = null,
}: ExplorerImportActionProps): ReactElement {
  const { toast } = useToast();
  const dbContext = usePGliteDatabase();
  const embeddingSetsRepository = useEmbeddingSetsRepository();
  const [pickerOpen, setPickerOpen] = useState(false);

  const activeCollectionId = useVectorStatusUIStore((state) => state.activeEmbeddingSetId);
  const setActiveCollectionId = useVectorStatusUIStore((state) => state.setActiveEmbeddingSetId);
  const upsertCachedCollection = useVectorStatusUIStore((state) => state.upsertCachedCollection);
  const activeCollectionSystemRole = useVectorStatusUIStore(
    (state) =>
      state.cachedCollections.find((candidate) => candidate.id === state.activeEmbeddingSetId)
        ?.systemRole ?? null
  );
  const managedCollectionId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const isManagedCollection = Boolean(
    activeCollectionId &&
      (activeCollectionSystemRole === 'workspace-index' ||
        activeCollectionId === managedCollectionId)
  );

  const collectionDialogs = useCollectionDialogs();
  const importSettings = useImportSettings();
  const importFlowSettings = useImportFlowSettings(importSettings);
  const resolveActiveCollectionId = useCallback(() => activeCollectionId, [activeCollectionId]);

  const handleImportComplete = useCallback(
    async (results: EnhancedImportResult[]) => {
      // The explorer owns no record/chunk grid, so only the collection stats
      // refresh is wired here (see createImportCompletionHandler).
      const handler = createImportCompletionHandler(toast, undefined, undefined, async () => {
        if (!dbContext) {
          throw new Error('Import completion stats refresh requires an initialized database.');
        }
        if (!activeCollectionId) {
          throw new Error('Import completion stats refresh requires an active collection.');
        }
        await refreshCollectionIndexingStats(dbContext, [activeCollectionId], {
          label: 'explorer import completion stats refresh',
          priority: 'foreground',
        });
      });
      await handler(results);
    },
    [activeCollectionId, dbContext, toast]
  );

  const importFlow = useImportFlow({
    embeddingQueue,
    importSettings: importFlowSettings,
    onImportComplete: handleImportComplete,
    resolveActiveCollectionId,
    toast,
  });

  // System-owned collections never reach here: they are filtered out of the
  // picker's list AND rejected by CollectionPicker's own protection check. No
  // defensive re-check — a workspace-index id arriving here would be a bug we
  // want to see, not swallow.
  const handleCollectionChange = setActiveCollectionId;

  const handleCollectionCreated = useCallback(
    (newSetId: string, newSet: EmbeddingSet) => {
      upsertCachedCollection(collectionCacheSnapshotFromEmbeddingSet(newSet));
      handleCollectionChange(newSetId);
      collectionDialogs.closeCreateDialog();
    },
    [collectionDialogs.closeCreateDialog, handleCollectionChange, upsertCachedCollection]
  );

  const handleActiveCollectionDeleted = useCallback(() => {
    setActiveCollectionId(null);
  }, [setActiveCollectionId]);

  const handleImport = useCallback(() => {
    setPickerOpen(false);
    importFlow.handleImportClick();
  }, [importFlow.handleImportClick]);

  // The import service lives in this component, and this component is a child
  // of the selection bar. Without the pin, clearing the selection mid-import
  // would unmount the service: its cleanup clears the app-wide
  // embedding-queue-active flag and its progress state goes with it. Pinning
  // holds the bar (and this subtree) open until the run is acknowledged.
  useSelectionActionBarPin(importFlow.isImporting || importFlow.showImportProgress);

  // This is the only surface that runs imports, so it is also the only one that
  // can report their progress. The Database panel's observability hook reads
  // what we publish here instead of owning a duplicate import service.
  useEffect(() => {
    publishImportActivitySnapshot({
      progress: importFlow.progress,
      selectedFileCount: importFlow.selectedFileCount,
    });
    return clearImportActivitySnapshot;
  }, [importFlow.progress, importFlow.selectedFileCount]);

  const blockReason = resolveImportBlockReason({
    activeCollectionId,
    isImporting: importFlow.isImporting,
    isManagedCollection,
    selectedFileCount: importFlow.selectedFileCount,
  });

  return (
    <>
      {importFlow.showImportProgress && importFlow.progress ? (
        // Raised above the selection bar (its wrapper is the positioned
        // ancestor) so progress stays visible after the picker closes without
        // pushing the bar — or the tree — around.
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-xl border border-border/80 bg-popover/95 shadow-lg backdrop-blur-sm"
          data-testid="explorer-import-progress"
        >
          <ImportProgressBar
            isCancelling={importFlow.isCancelling}
            onCancel={importFlow.handleCancelImport}
            onClose={() => importFlow.setShowImportProgress(false)}
            progress={importFlow.progress as EnhancedImportProgress}
          />
        </div>
      ) : null}

      <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={`Import into collection (${importFlow.selectedFileCount})`}
            className="gap-1.5 whitespace-nowrap motion-reduce:transition-none"
            size="sm"
            title="Import the selected files into a collection"
            type="button"
            variant="secondary"
          >
            <FileText aria-hidden="true" className="h-4 w-4" />
            <span className="@[360px]/selection-actions:inline hidden">Import</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[min(92vw,24rem)] p-3"
          collisionPadding={12}
          data-testid="explorer-import-picker"
          side="top"
        >
          <div className="flex flex-col gap-3">
            <ExplorerCollectionPicker
              activeCollectionId={activeCollectionId}
              db={dbContext}
              onCollectionChange={handleCollectionChange}
              onCreateCollection={collectionDialogs.handleCreateCollection}
              onDeleteCollection={collectionDialogs.handleDeleteCollection}
              onEditCollection={collectionDialogs.handleEditCollection}
            />

            {isManagedCollection ? (
              <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-primary text-xs">
                {MANAGED_COLLECTION_BLOCK_REASON}
              </p>
            ) : null}

            <Button
              aria-label="Import selected files into collection"
              className="w-full"
              data-testid="explorer-import-confirm"
              disabled={blockReason !== null}
              onClick={handleImport}
              size="sm"
              title={blockReason ?? 'Import the selected files into this collection'}
              type="button"
            >
              Import {importFlow.selectedFileCount.toLocaleString()}{' '}
              {importFlow.selectedFileCount === 1 ? 'file' : 'files'}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <DatabaseDemoCollectionDialogs
        activeCollectionId={activeCollectionId}
        collectionDialogs={collectionDialogs}
        createDialog={
          collectionDialogs.createCollectionOpen ? (
            <CreateCollectionDialog
              db={dbContext}
              onClose={collectionDialogs.closeCreateDialog}
              onCreated={handleCollectionCreated}
              repository={embeddingSetsRepository}
            />
          ) : null
        }
        dbContext={dbContext}
        embeddingSetsRepository={embeddingSetsRepository}
        onActiveCollectionDeleted={handleActiveCollectionDeleted}
      />
    </>
  );
}

ExplorerImportAction.displayName = 'ExplorerImportAction';
