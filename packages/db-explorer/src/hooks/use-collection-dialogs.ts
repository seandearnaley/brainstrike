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

  const handleEditCollection = useCallback((collection: CollectionPickerCollection) => {
    setSelectedCollection(collection);
    setRenameDialogOpen(true);
  }, []);

  const handleDeleteCollection = useCallback((collection: CollectionPickerCollection) => {
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
    // Dialog open states
    createCollectionOpen,
    renameDialogOpen,
    deleteDialogOpen,
    selectedCollection,

    // Handlers to open dialogs
    handleCreateCollection,
    handleEditCollection,
    handleDeleteCollection,

    // Handlers to close dialogs
    closeCreateDialog,
    closeRenameDialog,
    closeDeleteDialog,
  };
}
