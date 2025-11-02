import type { EmbeddingSet, EmbeddingSetsRepository } from '@brainstrike/db';
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
import { useEffect, useState } from 'react';

interface RenameEmbeddingSetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: EmbeddingSetsRepository | null;
  embeddingSet: EmbeddingSet | null;
  onSetRenamed?: (setId: string) => void;
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
    name: '',
    description: '',
    tags: '',
    category: '',
  });

  // Initialize form when embedding set changes
  useEffect(() => {
    if (embeddingSet) {
      setFormData({
        name: embeddingSet.name ?? '',
        description: embeddingSet.description ?? '',
        tags: embeddingSet.tags ?? '',
        category: embeddingSet.category ?? '',
      });
    }
  }, [embeddingSet]);

  const validateInputs = (): boolean => {
    if (!repository || !embeddingSet) {
      toast({
        title: 'Error',
        description: 'Invalid configuration',
        variant: 'destructive',
      });
      return false;
    }

    if (!formData.name.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Please provide a name for the embedding set',
        variant: 'destructive',
      });
      return false;
    }

    return true;
  };

  const handleUpdate = async () => {
    if (!validateInputs() || !repository || !embeddingSet) {
      return;
    }

    setUpdating(true);
    try {
      const metadata = buildMetadata(formData);

      await repository.updateMetadata(embeddingSet.id, metadata);

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
        description: `Updated embedding set: ${formData.name}`,
      });

      onOpenChange(false);
      onSetRenamed?.(embeddingSet.id);
    } catch (error) {
      console.error('[RenameEmbeddingSetDialog] Failed to update set:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update embedding set',
        variant: 'destructive',
      });
    } finally {
      setUpdating(false);
    }
  };

  if (!embeddingSet) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Embedding Set</DialogTitle>
          <DialogDescription>
            Update the metadata for this embedding set. The model configuration cannot be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-muted-foreground">Model Configuration</Label>
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="font-medium">{embeddingSet.modelId}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {embeddingSet.dimensions}D · {embeddingSet.distance} · {embeddingSet.modelKey}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-name" className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="edit-name"
              placeholder="e.g., Code Embeddings, General Purpose, etc."
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              disabled={updating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-description" className="text-sm font-medium">
              Description
            </Label>
            <Input
              id="edit-description"
              placeholder="Describe the purpose of this embedding set"
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              disabled={updating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-tags" className="text-sm font-medium">
              Tags
            </Label>
            <Input
              id="edit-tags"
              placeholder="Comma-separated tags (e.g., code, programming, analysis)"
              value={formData.tags}
              onChange={(e) => setFormData((prev) => ({ ...prev, tags: e.target.value }))}
              disabled={updating}
            />
            <p className="text-xs text-muted-foreground">Use commas to separate multiple tags</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-category" className="text-sm font-medium">
              Category
            </Label>
            <Input
              id="edit-category"
              placeholder="e.g., development, documentation, general-text"
              value={formData.category}
              onChange={(e) => setFormData((prev) => ({ ...prev, category: e.target.value }))}
              disabled={updating}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updating}
            type="button"
          >
            Cancel
          </Button>
          <Button onClick={handleUpdate} disabled={updating || !formData.name.trim()} type="button">
            {updating ? 'Updating...' : 'Save Changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
