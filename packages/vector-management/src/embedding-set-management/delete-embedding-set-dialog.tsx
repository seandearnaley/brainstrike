import type { EmbeddingSet } from '@brainstrike/db';
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
import type { PGlite } from '@electric-sql/pglite';
import { useState } from 'react';

interface DeleteEmbeddingSetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  db: PGlite | null;
  embeddingSet: (EmbeddingSet & { chunkCount: number }) | null;
  onSetDeleted?: (setId: string) => void;
}

export function DeleteEmbeddingSetDialog({
  open,
  onOpenChange,
  db,
  embeddingSet,
  onSetDeleted,
}: DeleteEmbeddingSetDialogProps) {
  const { toast } = useToast();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!db || !embeddingSet) {
      toast({
        title: 'Error',
        description: 'Invalid configuration',
        variant: 'destructive',
      });
      return;
    }

    setDeleting(true);
    try {
      // Delete all chunks associated with this collection
      await db.query('DELETE FROM file_chunks WHERE embedding_set_id = $1', [embeddingSet.id]);

      // Delete the collection itself
      await db.query('DELETE FROM embedding_sets WHERE id = $1', [embeddingSet.id]);

      // Emit event to notify other components
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('brainstrike:embedding-set-updated', {
            detail: { id: embeddingSet.id },
          })
        );
      }

      toast({
        title: 'Success',
        description: `Deleted collection: ${embeddingSet.name ?? embeddingSet.modelKey}`,
      });

      onOpenChange(false);
      onSetDeleted?.(embeddingSet.id);
    } catch (error) {
      console.error('[DeleteEmbeddingSetDialog] Failed to delete set:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete collection',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (!embeddingSet) {
    return null;
  }

  const setName = embeddingSet.name ?? embeddingSet.modelKey;
  const hasChunks = embeddingSet.chunkCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Delete Search Collection</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete the collection and all
            associated embeddings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 space-y-3">
            <div>
              <div className="font-medium text-sm">Search Collection</div>
              <div className="text-sm mt-1">{setName}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {embeddingSet.modelId} · {embeddingSet.dimensions}D · {embeddingSet.distance}
              </div>
            </div>

            {hasChunks && (
              <div className="pt-3 border-t border-destructive/20">
                <div className="font-medium text-sm text-destructive">Warning</div>
                <div className="text-sm mt-1">
                  This collection contains{' '}
                  <span className="font-semibold">{embeddingSet.chunkCount.toLocaleString()}</span>{' '}
                  embedded chunks. Deleting this collection will remove all these embeddings from
                  the database.
                </div>
              </div>
            )}
          </div>

          <div className="text-sm text-muted-foreground">
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
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
            type="button"
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting} type="button">
            {deleting ? 'Deleting...' : 'Delete Collection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
