import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
import type { usePGliteDatabase } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import {
  CollectionPicker,
  type CollectionPickerCollection,
  ErrorBoundary,
  getCollectionPickerProtection,
} from '@brainstrike/ui';
import { fetchCollectionsSnapshot } from '@brainstrike/vector-management';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';

const logger = createLogger('ExplorerCollectionPicker');

interface ExplorerCollectionPickerProps {
  readonly activeCollectionId: string | null;
  readonly db: ReturnType<typeof usePGliteDatabase>;
  readonly onCollectionChange: (collectionId: string | null) => void;
  readonly onCreateCollection: () => void;
  readonly onDeleteCollection: (collection: CollectionPickerCollection) => void;
  readonly onEditCollection: (collection: CollectionPickerCollection) => void;
}

/**
 * Collection picker for the explorer's import popover.
 *
 * Unlike `SearchCollectionSelector` this does NOT mount `useCollections`: the
 * Database panel already owns that live query, and a second instance
 * ping-pongs the shared `cachedCollections` store (each applies its own
 * pending mutations, so they never agree) until React aborts the render loop.
 * The store cache is the shared source of truth; this popover reads it and
 * tops it up with a single query when it opens against an empty cache — which
 * is the case whenever the Database tab has never been mounted.
 */
export function ExplorerCollectionPicker({
  activeCollectionId,
  db,
  onCollectionChange,
  onCreateCollection,
  onDeleteCollection,
  onEditCollection,
}: ExplorerCollectionPickerProps): ReactElement {
  const cachedCollections = useVectorStatusUIStore((state) => state.cachedCollections);
  const setCachedCollections = useVectorStatusUIStore((state) => state.setCachedCollections);
  const [isSeeding, setIsSeeding] = useState(false);

  // One-shot seed. Only when nothing is cached — a populated cache is already
  // being kept current by whichever surface owns the live query.
  useEffect(() => {
    if (cachedCollections.length > 0 || !db) {
      return;
    }

    let cancelled = false;
    setIsSeeding(true);
    fetchCollectionsSnapshot(db)
      .then((collections) => {
        if (cancelled) {
          return;
        }
        if (collections.length > 0) {
          setCachedCollections(collections);
        }
      })
      .catch((error: unknown) => {
        logger.error('Failed to load collections for the explorer import picker', { error });
      })
      .finally(() => {
        if (!cancelled) {
          setIsSeeding(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cachedCollections.length, db, setCachedCollections]);

  // Same rule as SearchCollectionSelector: workspace-index sets are never a
  // manual import target and must not appear as one.
  const visibleCollections = useMemo(
    () => cachedCollections.filter((collection) => collection.systemRole !== 'workspace-index'),
    [cachedCollections]
  );

  const selectedCollection = useMemo(
    () => cachedCollections.find((collection) => collection.id === activeCollectionId) ?? null,
    [activeCollectionId, cachedCollections]
  );
  const selectedId =
    selectedCollection && !getCollectionPickerProtection(selectedCollection).isDisabled
      ? activeCollectionId
      : null;

  const handleEdit = useCallback(
    (collection: CollectionPickerCollection) => {
      if (!getCollectionPickerProtection(collection).canEdit) {
        return;
      }
      onEditCollection(collection);
    },
    [onEditCollection]
  );

  const handleDelete = useCallback(
    (collection: CollectionPickerCollection) => {
      if (!getCollectionPickerProtection(collection).canDelete) {
        return;
      }
      onDeleteCollection(collection);
    },
    [onDeleteCollection]
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
