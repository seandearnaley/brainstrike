import type { EmbeddingSetsRepository } from '@brainstrike/db';
import { parseProviderModelKey } from '@brainstrike/embeddings';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@brainstrike/ui';
import { useState } from 'react';

interface CreateEmbeddingSetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: EmbeddingSetsRepository | null;
  availableModels: Array<{
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'l2' | 'ip';
    provider: string;
  }>;
  onSetCreated?: (setId: string) => void;
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

export function CreateEmbeddingSetDialog({
  open,
  onOpenChange,
  repository,
  availableModels,
  onSetCreated,
}: CreateEmbeddingSetDialogProps) {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    tags: '',
    category: '',
    selectedModel: '',
  });

  const selectedModelInfo = availableModels.find((m) => m.modelKey === formData.selectedModel);

  const validateCreateInputs = (): boolean => {
    if (!repository || !selectedModelInfo) {
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

  const handleCreate = async () => {
    if (!validateCreateInputs() || !repository || !selectedModelInfo) {
      return;
    }

    setCreating(true);
    try {
      const metadata = buildMetadata(formData);

      const newSet = await repository.getOrCreateSet(
        selectedModelInfo.modelKey,
        selectedModelInfo.modelId,
        selectedModelInfo.dimensions,
        selectedModelInfo.distance,
        metadata
      );

      // Emit event to notify other components
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('brainstrike:embedding-set-updated', {
            detail: { id: newSet.id },
          })
        );
      }

      toast({
        title: 'Success',
        description: `Created embedding set: ${formData.name}`,
      });

      // Reset form
      setFormData({
        name: '',
        description: '',
        tags: '',
        category: '',
        selectedModel: '',
      });

      onOpenChange(false);
      onSetCreated?.(newSet.id);
    } catch (error) {
      console.error('[CreateEmbeddingSetDialog] Failed to create set:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create embedding set',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const formatModelLabel = (model: (typeof availableModels)[number]) => {
    const parsed = parseProviderModelKey(model.modelKey);
    let providerLabel = 'Unknown';

    if (parsed?.provider === 'local') {
      providerLabel = 'Local';
    } else if (parsed?.provider) {
      providerLabel = parsed.provider.charAt(0).toUpperCase() + parsed.provider.slice(1);
    }

    return `${providerLabel} · ${model.modelId} (${model.dimensions}D ${model.distance})`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Embedding Set</DialogTitle>
          <DialogDescription>
            Create a new embedding set to organize your vector embeddings. Each set represents a
            unique combination of model, dimensions, and distance metric.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="model" className="text-sm font-medium">
              Model Configuration
            </Label>
            <Select
              value={formData.selectedModel}
              onValueChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  selectedModel: value,
                  // Auto-populate name if empty
                  name:
                    prev.name === ''
                      ? (availableModels.find((m) => m.modelKey === value)?.modelId ?? '')
                      : prev.name,
                }))
              }
            >
              <SelectTrigger id="model" className="w-full">
                <SelectValue placeholder="Select a model configuration" />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((model) => (
                  <SelectItem key={model.modelKey} value={model.modelKey}>
                    {formatModelLabel(model)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="name"
              placeholder="e.g., Code Embeddings, General Purpose, etc."
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              disabled={creating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-sm font-medium">
              Description
            </Label>
            <Input
              id="description"
              placeholder="Describe the purpose of this embedding set"
              value={formData.description}
              onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              disabled={creating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tags" className="text-sm font-medium">
              Tags
            </Label>
            <Input
              id="tags"
              placeholder="Comma-separated tags (e.g., code, programming, analysis)"
              value={formData.tags}
              onChange={(e) => setFormData((prev) => ({ ...prev, tags: e.target.value }))}
              disabled={creating}
            />
            <p className="text-xs text-muted-foreground">Use commas to separate multiple tags</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="category" className="text-sm font-medium">
              Category
            </Label>
            <Input
              id="category"
              placeholder="e.g., development, documentation, general-text"
              value={formData.category}
              onChange={(e) => setFormData((prev) => ({ ...prev, category: e.target.value }))}
              disabled={creating}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
            type="button"
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || !formData.selectedModel || !formData.name.trim()}
            type="button"
          >
            {creating ? 'Creating...' : 'Create Set'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
