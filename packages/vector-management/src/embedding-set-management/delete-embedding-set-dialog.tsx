import type { EmbeddingSet, IEmbeddingSetsRepository } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useState } from 'react';
import { dispatchEmbeddingSetUpdated } from '../collection-select/embedding-set-events';

interface DeleteEmbeddingSetDialogProps {
  embeddingSet: (EmbeddingSet & { chunkCount: number }) | null;
  onOpenChange: (open: boolean) => void;
  onSetDeleted?: (setId: string) => void;
  open: boolean;
  repository: IEmbeddingSetsRepository | null;
}

const logger = createLogger('DeleteEmbeddingSetDialog');

export function DeleteEmbeddingSetDialog({
  open,
  onOpenChange,
  embeddingSet,
  onSetDeleted,
  repository,
}: DeleteEmbeddingSetDialogProps) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);
  // Use the functional action to avoid stale closure bugs in async handlers
  const removeCachedCollection = useVectorStatusUIStore((s) => s.removeCachedCollection);

  const handleDelete = async () => {
    if (!(repository && embeddingSet)) {
      toast({
        title: 'Error',
        description: 'Invalid configuration',
        variant: 'destructive',
      });
      return;
    }

    const collectionName = embeddingSet.name ?? embeddingSet.modelKey;
    const collectionId = embeddingSet.id;

    setDeleting(true);
    try {
      const deleted = await repository.delete(collectionId);
      if (!deleted) {
        throw new Error(`Collection not found: ${collectionId}`);
      }

      // Immediately update the Zustand cache to remove the deleted collection
      // This ensures UI updates instantly without waiting for live query refresh
      // Uses functional action to avoid stale closure bugs
      removeCachedCollection(collectionId);

      dispatchEmbeddingSetUpdated({
        id: collectionId,
        reason: 'deleted',
      });

      toast({
        title: 'Success',
        description: `Deleted collection: ${collectionName}`,
      });

      setDeleting(false);
      onOpenChange(false);
    } catch (error) {
      setDeleting(false);
      logger.error('Failed to delete embedding set', { error });
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete collection',
        variant: 'destructive',
      });
      return;
    }
    onSetDeleted?.(collectionId);
  };

  if (!embeddingSet) {
    return null;
  }

  const setName = embeddingSet.name ?? embeddingSet.modelKey;
  const hasChunks = embeddingSet.chunkCount > 0;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Delete Search Collection</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the collection and all
            associated embeddings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-3 rounded-md border border-destructive/50 bg-destructive/10 p-4">
            <div>
              <div className="font-medium text-sm">Search Collection</div>
              <div className="mt-1 text-sm">{setName}</div>
              <div className="mt-1 text-muted-foreground text-xs">
                {embeddingSet.modelId} · {embeddingSet.dimensions}D · {embeddingSet.distance}
              </div>
            </div>

            {hasChunks && (
              <div className="border-destructive/20 border-t pt-3">
                <div className="font-medium text-destructive text-sm">Warning</div>
                <div className="mt-1 text-sm">
                  This collection contains{' '}
                  <span className="font-semibold">{embeddingSet.chunkCount.toLocaleString()}</span>{' '}
                  embedded chunks. Deleting this collection will remove all these embeddings from
                  the database.
                </div>
              </div>
            )}
          </div>

          <div className="text-muted-foreground text-sm">
            {hasChunks ? (
              <p>
                The file records will remain in the database, but you will need to re-embed them if
                you want to search them with this model configuration again.
              </p>
            ) : (
              <p>This collection has no associated chunks and can be safely deleted.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={deleting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={deleting} onClick={handleDelete} type="button" variant="destructive">
            {deleting ? 'Deleting...' : 'Delete Collection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
