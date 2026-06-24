import type { DbHandle } from '@brainstrike/db';
import {
  CollectionPicker,
  type CollectionPickerCollection,
  ErrorBoundary,
  getCollectionPickerProtection,
  useToast,
} from '@brainstrike/ui';
import { useCollections } from '@brainstrike/vector-management';
import { useCallback, useEffect, useMemo, useRef } from 'react';

interface SearchCollectionSelectorProps {
  /**
   * Currently active collection ID
   */
  activeCollectionId: string | null;
  /**
   * The database instance for querying collections
   */
  db: DbHandle | null;

  /**
   * Callback when collection selection changes
   */
  onCollectionChange: (collectionId: string | null) => void;

  /**
   * Callback to open the create collection dialog
   */
  onCreateCollection: () => void;

  /**
   * Callback when delete is clicked on a collection
   */
  onDeleteCollection: (collection: CollectionPickerCollection) => void;

  /**
   * Callback when edit is clicked on a collection
   */
  onEditCollection: (collection: CollectionPickerCollection) => void;
}

/**
 * SearchCollectionSelector - User-friendly collection picker for Database Explorer
 *
 * This component displays a scrollable list of collections with:
 * - Rich metadata display (provider, dimensions, distance, file count)
 * - Inline edit and delete buttons per collection
 * - Unique colors per collection
 * - Empty state with "Create First Collection" CTA
 *
 * For the compact dropdown version, see EmbeddingSetSelector in vector-management.
 */
export function SearchCollectionSelector({
  db,
  activeCollectionId,
  onCollectionChange,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
}: SearchCollectionSelectorProps) {
  const { toast } = useToast();
  const lastToastErrorRef = useRef<string | null>(null);

  // Use shared hook for collection data
  const { collections, loading, error } = useCollections(db);
  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === activeCollectionId) ?? null,
    [activeCollectionId, collections]
  );
  const selectedId =
    selectedCollection && !getCollectionPickerProtection(selectedCollection).isDisabled
      ? activeCollectionId
      : null;

  // Handle errors with toast notifications
  useEffect(() => {
    if (!error) {
      lastToastErrorRef.current = null;
      return;
    }
    const message =
      error instanceof Error ? error.message : 'Unable to retrieve collections from database';
    if (lastToastErrorRef.current === message) {
      return;
    }
    lastToastErrorRef.current = message;
    toast({
      title: 'Failed to Load Collections',
      description: message,
      variant: 'destructive',
    });
  }, [error, toast]);

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
      const collection = collections.find((candidate) => candidate.id === collectionId);
      if (collection && getCollectionPickerProtection(collection).isDisabled) {
        return;
      }
      onCollectionChange(collectionId);
    },
    [collections, onCollectionChange]
  );

  return (
    <ErrorBoundary>
      <CollectionPicker
        collections={collections}
        loading={loading}
        maxHeight="none"
        onCreate={onCreateCollection}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onSelect={handleSelect}
        selectedId={selectedId}
        showHeader={false}
      />
    </ErrorBoundary>
  );
}

// Re-export the type for use in parent components
export type { CollectionPickerCollection };
