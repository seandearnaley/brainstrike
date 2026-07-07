import { useCallback, useState } from 'react';
import type { CollectionPickerCollection } from '../components';

/**
 * Hook to manage the collection dialog states (create, rename, delete).
 *
 * Extracts dialog management logic from DatabaseDemoPanel to reduce cognitive complexity.
 */
export function useCollectionDialogs() {
  const [createCollectionOpen, setCreateCollectionOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState<CollectionPickerCollection | null>(
    null
  );

  const handleCreateCollection = useCallback(() => {
    setCreateCollectionOpen(true);
  }, []);

  const handleEditCollection = useCallback((collection: CollectionPickerCollection | null) => {
    if (!collection) {
      return;
    }
    setSelectedCollection(collection);
    setRenameDialogOpen(true);
  }, []);

  const handleDeleteCollection = useCallback((collection: CollectionPickerCollection | null) => {
    if (!collection) {
      return;
    }
    setSelectedCollection(collection);
    setDeleteDialogOpen(true);
  }, []);

  const closeCreateDialog = useCallback(() => {
    setCreateCollectionOpen(false);
  }, []);

  const closeRenameDialog = useCallback(() => {
    setRenameDialogOpen(false);
    setSelectedCollection(null);
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteDialogOpen(false);
    setSelectedCollection(null);
  }, []);

  return {
    // Handlers to close dialogs
    closeCreateDialog,
    closeDeleteDialog,
    closeRenameDialog,
    // Dialog open states
    createCollectionOpen,
    deleteDialogOpen,

    // Handlers to open dialogs
    handleCreateCollection,
    handleDeleteCollection,
    handleEditCollection,
    renameDialogOpen,
    selectedCollection,
  };
}
