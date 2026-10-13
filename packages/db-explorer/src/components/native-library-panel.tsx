import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { onEmbeddingSetUpdated, onQueueDrained } from '@brainstrike/utils/browser-events';
import { useEffect, useState } from 'react';
import { useCollectionCacheSync } from '../hooks/use-collection-cache-sync';
import { useCollectionDialogs } from '../hooks/use-collection-dialogs';
import { useImportSettings } from '../hooks/use-import-settings';
import { useNativeContentClear } from '../hooks/use-native-content-clear';
import { exportNativeLibrary } from '../native-library-export';
import { collectionCacheSnapshotFromEmbeddingSet } from '../utils/collection-cache-snapshot';
import { ClearDatabaseDialog } from './clear-database-dialog';
import { CreateCollectionDialog } from './create-collection-dialog';
import { DatabaseDemoCollectionDialogs } from './database-demo-collection-dialogs';
import { NativeLibraryFiles } from './native-library-files';
import { SearchCollectionSelector } from './search-collection-selector';
import { SettingsPanel } from './settings-panel';

/** Desktop uses the existing catalog/source/index capabilities, with no database provider mount. */
export function NativeLibraryPanel({ files }: { files: SourceFilesCapability }) {
  const collectionId = useVectorStatusUIStore((state) => state.activeEmbeddingSetId);
  const select = useVectorStatusUIStore((state) => state.setActiveEmbeddingSetId);
  const upsert = useVectorStatusUIStore((state) => state.upsertCachedCollection);
  const importing = useVectorStatusUIStore((state) => state.isImporting);
  const collections = useEmbeddingSetsRepository();
  const dialogs = useCollectionDialogs();
  const settings = useImportSettings();
  useCollectionCacheSync();
  const [revision, setRevision] = useState(0);
  const contentClear = useNativeContentClear(files, revision);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const removeSet = onEmbeddingSetUpdated(refresh);
    const removeQueue = onQueueDrained(refresh);
    return () => {
      removeSet();
      removeQueue();
    };
  }, []);
  const exportData = async (kind: Parameters<typeof exportNativeLibrary>[2]) => {
    setExporting(true);
    setError(null);
    try {
      await exportNativeLibrary(files, collectionId, kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-panel-surface"
      data-testid="database-demo-panel"
    >
      <div
        className="flex flex-wrap items-center gap-2 border-b p-2"
        data-testid="database-panel-toolbar"
      >
        <Button aria-label="New" onClick={dialogs.handleCreateCollection} size="sm">
          New
        </Button>
        <Button onClick={() => setRevision((value) => value + 1)} size="sm" variant="ghost">
          Refresh
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost">
              Import settings
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(96vw,48rem)]">
            <SettingsPanel clearDatabaseProps={contentClear} importSettings={settings} />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button disabled={exporting} size="sm" variant="outline">
              Export
            </Button>
          </PopoverTrigger>
          <PopoverContent className="flex flex-col gap-1">
            {(['files', 'chunks', 'vectors', 'all'] as const).map((kind) => (
              <Button
                disabled={exporting}
                key={kind}
                onClick={() => {
                  void exportData(kind);
                }}
                variant="ghost"
              >
                {kind === 'all' ? 'Export ZIP' : `Export ${kind}`}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      {contentClear.error ? (
        <p className="p-2 text-destructive" role="alert">
          {contentClear.error}
        </p>
      ) : null}
      <ClearDatabaseDialog {...contentClear} />
      {error ? (
        <p className="p-2 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <SearchCollectionSelector
        activeCollectionId={collectionId}
        db={null}
        onCollectionChange={select}
        onCreateCollection={dialogs.handleCreateCollection}
        onDeleteCollection={dialogs.handleDeleteCollection}
        onEditCollection={dialogs.handleEditCollection}
      />
      <NativeLibraryFiles
        collectionId={collectionId}
        files={files}
        key={collectionId ?? 'unassigned'}
        revision={revision + (importing ? 1 : 0)}
      />
      <DatabaseDemoCollectionDialogs
        activeCollectionId={collectionId}
        collectionDialogs={dialogs}
        createDialog={
          dialogs.createCollectionOpen ? (
            <CreateCollectionDialog
              db={null}
              onClose={dialogs.closeCreateDialog}
              onCreated={(id, set) => {
                upsert(collectionCacheSnapshotFromEmbeddingSet(set));
                select(id);
                dialogs.closeCreateDialog();
              }}
              repository={collections}
            />
          ) : null
        }
        embeddingSetsRepository={collections}
        onActiveCollectionDeleted={() => select(null)}
      />
    </div>
  );
}
