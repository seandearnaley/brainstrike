import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import { createLogger } from '@brainstrike/logging';
import {
  CollectionPicker,
  type CollectionPickerCollection,
  ErrorBoundary,
  getCollectionPickerProtection,
  useToast,
} from '@brainstrike/ui';
import { fetchCollectionsSnapshot } from '@brainstrike/vector-management';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';

const logger = createLogger('ExplorerCollectionPicker');

export const IMPORT_IN_FLIGHT_BLOCK_REASON =
  'An import is writing into this collection — finish or cancel it first';

interface ExplorerCollectionPickerProps {
  readonly activeCollectionId: string | null;
  /**
   * The collection an import is CURRENTLY writing into, if any. Renaming it is
   * merely confusing; deleting it orphans every chunk the run writes after the
   * delete, because `file_chunks.embedding_set_id` carries no foreign key. Its
   * edit/delete controls are disabled with a visible reason until the run
   * settles — never silently dropped.
   */
  readonly mutationBlockedCollectionId?: string | null;
  readonly onCollectionChange: (collectionId: string | null) => void;
  readonly onCreateCollection: () => void;
  readonly onDeleteCollection: (collection: CollectionPickerCollection) => void;
  readonly onEditCollection: (collection: CollectionPickerCollection) => void;
}

/**
 * Collection picker for the explorer's import popover.
 *
 * Unlike `SearchCollectionSelector` this does NOT mount `useCollections`: the
 * Database panel already owns that reader, and a second instance
 * ping-pongs the shared `cachedCollections` store (each applies its own
 * pending mutations, so they never agree) until React aborts the render loop.
 * The store cache is the shared source of truth; this popover reads it and
 * tops it up with a single query when it opens against an empty cache — which
 * is the case whenever the Database tab has never been mounted.
 */
export function ExplorerCollectionPicker({
  activeCollectionId,
  onCollectionChange,
  onCreateCollection,
  mutationBlockedCollectionId = null,
  onDeleteCollection,
  onEditCollection,
}: ExplorerCollectionPickerProps): ReactElement {
  const { toast } = useToast();
  const cachedCollections = useVectorStatusUIStore((state) => state.cachedCollections);
  const setCachedCollections = useVectorStatusUIStore((state) => state.setCachedCollections);
  const [isSeeding, setIsSeeding] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);

  // One-shot seed. Only when nothing is cached — a populated cache is already
  // being kept current by whichever surface owns the live query.
  useEffect(() => {
    if (cachedCollections.length > 0) {
      return;
    }

    let cancelled = false;
    setIsSeeding(true);
    fetchCollectionsSnapshot()
      .then((collections) => {
        if (cancelled) {
          return;
        }
        setLoadError(null);
        if (collections.length > 0) {
          setCachedCollections(collections);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // NO SILENT FALLBACKS: an empty cache after a failed query is
        // indistinguishable from "no collections exist", and the empty state
        // invites the user to create a duplicate. Say what happened instead.
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error('Failed to load collections for the explorer import picker', {
          error: failure,
        });
        setLoadError(failure);
        toast({
          description: failure.message,
          title: 'Failed to Load Collections',
          variant: 'destructive',
        });
      })
      .finally(() => {
        if (!cancelled) {
          setIsSeeding(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cachedCollections.length, setCachedCollections, toast]);

  // Same rule as SearchCollectionSelector: workspace-index sets are never a
  // manual import target and must not appear as one.
  const visibleCollections = useMemo(
    () =>
      cachedCollections.flatMap((collection) => {
        if (collection.systemRole === 'workspace-index') {
          return [];
        }
        return collection.id === mutationBlockedCollectionId
          ? [{ ...collection, mutationBlockedReason: IMPORT_IN_FLIGHT_BLOCK_REASON }]
          : [collection];
      }),
    [cachedCollections, mutationBlockedCollectionId]
  );

  const selectedCollection = useMemo(
    () => cachedCollections.find((collection) => collection.id === activeCollectionId) ?? null,
    [activeCollectionId, cachedCollections]
  );
  const selectedId =
    selectedCollection && !getCollectionPickerProtection(selectedCollection).isDisabled
      ? activeCollectionId
      : null;

  // Re-checked here as well as in the item: the callback is the last gate
  // before a destructive dialog opens, and a run can start between render and
  // click.
  const handleEdit = useCallback(
    (collection: CollectionPickerCollection) => {
      if (
        !getCollectionPickerProtection(collection).canEdit ||
        collection.id === mutationBlockedCollectionId
      ) {
        return;
      }
      onEditCollection(collection);
    },
    [mutationBlockedCollectionId, onEditCollection]
  );

  const handleDelete = useCallback(
    (collection: CollectionPickerCollection) => {
      if (
        !getCollectionPickerProtection(collection).canDelete ||
        collection.id === mutationBlockedCollectionId
      ) {
        return;
      }
      onDeleteCollection(collection);
    },
    [mutationBlockedCollectionId, onDeleteCollection]
  );

  const handleSelect = useCallback(
    (collectionId: string | null) => {
      if (!collectionId) {
        onCollectionChange(null);
        return;
      }
      const collection = cachedCollections.find((candidate) => candidate.id === collectionId);
      if (collection && getCollectionPickerProtection(collection).isDisabled) {
        return;
      }
      onCollectionChange(collectionId);
    },
    [cachedCollections, onCollectionChange]
  );

  if (loadError) {
    return (
      <div
        className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
        data-testid="explorer-import-picker-error"
        role="alert"
      >
        <p className="font-medium">Couldn't load collections</p>
        <p className="mt-1 break-words">{loadError.message}</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <CollectionPicker
        collections={visibleCollections}
        headerLabel="Target Collection"
        loading={isSeeding}
        maxHeight="16rem"
        onCreate={onCreateCollection}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onSelect={handleSelect}
        selectedId={selectedId}
        showHeader
      />
    </ErrorBoundary>
  );
}
