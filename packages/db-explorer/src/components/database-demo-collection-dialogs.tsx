import type { EmbeddingSet } from '@brainstrike/db';
import type { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import { DeleteEmbeddingSetDialog, RenameEmbeddingSetDialog } from '@brainstrike/vector-management';
import type { ReactElement } from 'react';
import type { useCollectionDialogs } from '../hooks/use-collection-dialogs';

interface DatabaseDemoCollectionDialogsProps {
  readonly activeCollectionId: string | null;
  readonly collectionDialogs: ReturnType<typeof useCollectionDialogs>;
  readonly createDialog: ReactElement | null;
  readonly embeddingSetsRepository: ReturnType<typeof useEmbeddingSetsRepository>;
  readonly onActiveCollectionDeleted: () => void;
}

function toRenameEmbeddingSet(
  selectedCollection: NonNullable<ReturnType<typeof useCollectionDialogs>['selectedCollection']>
): Parameters<typeof RenameEmbeddingSetDialog>[0]['embeddingSet'] {
  return {
    chunkCount: selectedCollection.chunkCount,
    createdAt: selectedCollection.createdAt,
    dimensions: selectedCollection.dimensions,
    distance: selectedCollection.distance,
    embeddingCount: selectedCollection.embeddingCount,
    fileCount: selectedCollection.fileCount,
    id: selectedCollection.id,
    modelId: selectedCollection.modelId,
    modelKey: selectedCollection.modelKey,
    ...(selectedCollection.name && { name: selectedCollection.name }),
    ...(selectedCollection.description && { description: selectedCollection.description }),
    ...(selectedCollection.tags && { tags: selectedCollection.tags }),
    ...(selectedCollection.category && { category: selectedCollection.category }),
  };
}

function toDeleteEmbeddingSet(
  selectedCollection: NonNullable<ReturnType<typeof useCollectionDialogs>['selectedCollection']>
): EmbeddingSet & { chunkCount: number } {
  return {
    chunkCount: selectedCollection.chunkCount,
    createdAt: selectedCollection.createdAt,
    dimensions: selectedCollection.dimensions,
    distance: selectedCollection.distance,
    id: selectedCollection.id,
    modelId: selectedCollection.modelId,
    modelKey: selectedCollection.modelKey,
    ...(selectedCollection.name && { name: selectedCollection.name }),
    ...(selectedCollection.description && { description: selectedCollection.description }),
    ...(selectedCollection.tags && { tags: selectedCollection.tags }),
    ...(selectedCollection.category && { category: selectedCollection.category }),
  };
}

export function DatabaseDemoCollectionDialogs({
  activeCollectionId,
  collectionDialogs,
  createDialog,
  embeddingSetsRepository,
  onActiveCollectionDeleted,
}: DatabaseDemoCollectionDialogsProps): ReactElement {
  const selectedCollection = collectionDialogs.selectedCollection;

  return (
    <>
      {createDialog}
      {collectionDialogs.renameDialogOpen && selectedCollection ? (
        <RenameEmbeddingSetDialog
          embeddingSet={toRenameEmbeddingSet(selectedCollection)}
          onOpenChange={(open: boolean) => {
            if (!open) {
              collectionDialogs.closeRenameDialog();
            }
          }}
          onSetRenamed={collectionDialogs.closeRenameDialog}
          open={collectionDialogs.renameDialogOpen}
          repository={embeddingSetsRepository}
        />
      ) : null}
      {collectionDialogs.deleteDialogOpen && selectedCollection ? (
        <DeleteEmbeddingSetDialog
          embeddingSet={toDeleteEmbeddingSet(selectedCollection)}
          onOpenChange={(open: boolean) => {
            if (!open) {
              collectionDialogs.closeDeleteDialog();
            }
          }}
          onSetDeleted={(deletedId: string) => {
            collectionDialogs.closeDeleteDialog();
            if (activeCollectionId === deletedId) {
              onActiveCollectionDeleted();
            }
          }}
          open={collectionDialogs.deleteDialogOpen}
          repository={embeddingSetsRepository}
        />
      ) : null}
    </>
  );
}
