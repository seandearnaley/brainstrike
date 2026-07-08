import type { EmbeddingSet, IEmbeddingSetsRepository } from '@brainstrike/db';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils/logger';
import { useState } from 'react';
import { dispatchEmbeddingSetUpdated } from '../collection-select/embedding-set-events';

type RenameableEmbeddingSet = EmbeddingSet & {
  chunkCount: number;
  embeddingCount: number;
  fileCount: number;
};

interface RenameEmbeddingSetDialogProps {
  embeddingSet: RenameableEmbeddingSet | null;
  onOpenChange: (open: boolean) => void;
  onSetRenamed?: (setId: string) => void;
  open: boolean;
  repository: IEmbeddingSetsRepository | null;
}

// Helper to build metadata object with only non-empty fields
function buildMetadata(formData: {
  name: string;
  description: string;
  tags: string;
  category: string;
}): {
  name: string;
  description?: string;
  tags?: string;
  category?: string;
} {
  const metadata: {
    name: string;
    description?: string;
    tags?: string;
    category?: string;
  } = {
    name: formData.name.trim(),
  };

  const trimmedDescription = formData.description.trim();
  if (trimmedDescription) {
    metadata.description = trimmedDescription;
  }

  const trimmedTags = formData.tags.trim();
  if (trimmedTags) {
    metadata.tags = trimmedTags;
  }

  const trimmedCategory = formData.category.trim();
  if (trimmedCategory) {
    metadata.category = trimmedCategory;
  }

  return metadata;
}

const logger = createLogger('RenameEmbeddingSetDialog');

export function RenameEmbeddingSetDialog({
  open,
  onOpenChange,
  repository,
  embeddingSet,
  onSetRenamed,
}: RenameEmbeddingSetDialogProps) {
  const { toast } = useToast();
  const [updating, setUpdating] = useState(false);
  const [formData, setFormData] = useState({
    category: embeddingSet?.category ?? '',
    description: embeddingSet?.description ?? '',
    name: embeddingSet?.name ?? '',
    tags: embeddingSet?.tags ?? '',
  });

  const validateInputs = (): boolean => {
    if (!(repository && embeddingSet)) {
      toast({
        description: 'Invalid configuration',
        title: 'Error',
        variant: 'destructive',
      });
      return false;
    }

    if (!formData.name.trim()) {
      toast({
        description: 'Please provide a name for the collection',
        title: 'Validation Error',
        variant: 'destructive',
      });
      return false;
    }

    return true;
  };

  const handleUpdate = async () => {
    if (!(validateInputs() && repository && embeddingSet)) {
      return;
    }

    setUpdating(true);
    try {
      const metadata = buildMetadata(formData);

      await repository.updateMetadata(embeddingSet.id, metadata);

      dispatchEmbeddingSetUpdated({
        collection: {
          category: metadata.category ?? null,
          chunkCount: embeddingSet.chunkCount,
          createdAt: embeddingSet.createdAt,
          description: metadata.description ?? null,
          dimensions: embeddingSet.dimensions,
          distance: embeddingSet.distance,
          embeddingCount: embeddingSet.embeddingCount,
          fileCount: embeddingSet.fileCount,
          id: embeddingSet.id,
          modelId: embeddingSet.modelId,
          modelKey: embeddingSet.modelKey,
          name: metadata.name ?? null,
          tags: metadata.tags ?? null,
        },
        id: embeddingSet.id,
        reason: 'updated',
      });

      toast({
        description: `Updated collection: ${formData.name}`,
        title: 'Success',
      });

      setUpdating(false);
      onOpenChange(false);
    } catch (error) {
      setUpdating(false);
      logger.error('Failed to rename embedding set', { error });
      toast({
        description: error instanceof Error ? error.message : 'Failed to update collection',
        title: 'Error',
        variant: 'destructive',
      });
      return;
    }
    onSetRenamed?.(embeddingSet.id);
  };

  if (!embeddingSet) {
    return null;
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Search Collection</DialogTitle>
          <DialogDescription>
            Update the metadata for this collection. The model configuration cannot be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="font-medium text-muted-foreground text-sm">Model Configuration</Label>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="font-medium">{embeddingSet.modelId}</div>
              <div className="mt-1 text-muted-foreground text-xs">
                {embeddingSet.dimensions}D · {embeddingSet.distance} · {embeddingSet.modelKey}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="font-medium text-sm" htmlFor="edit-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              disabled={updating}
              id="edit-name"
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Code Embeddings, General Purpose, etc."
              value={formData.name}
            />
          </div>

          <div className="space-y-2">
            <Label className="font-medium text-sm" htmlFor="edit-description">
              Description
            </Label>
            <Input
              disabled={updating}
              id="edit-description"
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              placeholder="Describe the purpose of this collection"
              value={formData.description}
            />
          </div>

          <div className="space-y-2">
            <Label className="font-medium text-sm" htmlFor="edit-tags">
              Tags
            </Label>
            <Input
              disabled={updating}
              id="edit-tags"
              onChange={(e) => setFormData((prev) => ({ ...prev, tags: e.target.value }))}
              placeholder="Comma-separated tags (e.g., code, programming, analysis)"
              value={formData.tags}
            />
            <p className="text-muted-foreground text-xs">Use commas to separate multiple tags</p>
          </div>

          <div className="space-y-2">
            <Label className="font-medium text-sm" htmlFor="edit-category">
              Category
            </Label>
            <Input
              disabled={updating}
              id="edit-category"
              onChange={(e) => setFormData((prev) => ({ ...prev, category: e.target.value }))}
              placeholder="e.g., development, documentation, general-text"
              value={formData.category}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            disabled={updating}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={updating || !formData.name.trim()} onClick={handleUpdate} type="button">
            {updating ? 'Updating...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
