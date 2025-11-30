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
import { createLogger } from '@brainstrike/utils';
import { useEffect, useState } from 'react';
import { setActiveEmbeddingSetId } from '../vector-preferences';

type CreateEmbeddingSetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: EmbeddingSetsRepository | null;
  availableModels: Array<{
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'l2' | 'ip';
    provider: string;
    description?: string;
    tags?: string[];
    pricePer1MTokens?: number;
    origin?: string;
  }>;
  onSetCreated?: (setId: string) => void;
};

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

const logger = createLogger('CreateEmbeddingSetDialog');

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
  const hasModelOptions = availableModels.length > 0;

  useEffect(() => {
    if (!open) {
      return;
    }
    if (formData.selectedModel) {
      return;
    }
    if (!hasModelOptions) {
      return;
    }
    setFormData((prev) => ({ ...prev, selectedModel: availableModels[0]?.modelKey ?? '' }));
  }, [open, hasModelOptions, availableModels, formData.selectedModel]);

  const validateCreateInputs = (): boolean => {
    if (!(repository && selectedModelInfo)) {
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
    if (!(validateCreateInputs() && repository && selectedModelInfo)) {
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

      setActiveEmbeddingSetId(newSet.id);

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
      logger.error('Failed to create embedding set', { error });
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create collection',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const formatModelLabel = (model: (typeof availableModels)[number]) => {
    const parsed = parseProviderModelKey(model.modelKey);
    let providerLabel = 'Local'; // Default to Local for models without provider prefix

    if (parsed?.provider === 'local') {
      providerLabel = 'Local';
    } else if (parsed?.provider) {
      providerLabel = parsed.provider.charAt(0).toUpperCase() + parsed.provider.slice(1);
    }

    return `${providerLabel} · ${model.modelId} (${model.dimensions}D ${model.distance})`;
  };

  const formatModelDescription = (model: (typeof availableModels)[number]) => {
    const parts: string[] = [];

    // Add cost indicator
    if (model.pricePer1MTokens !== undefined) {
      parts.push(`💰 $${model.pricePer1MTokens.toFixed(2)}/1M tokens`);
    } else {
      parts.push('🔒 Free (local)');
    }

    // Add model description if available
    if (model.description) {
      parts.push(model.description);
    }

    // Add origin/use case if available
    if (model.origin) {
      parts.push(`Best for: ${model.origin.toLowerCase()}`);
    }

    return parts.join(' · ');
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Search Collection</DialogTitle>
          <DialogDescription>
            Collections let you search the same files with different AI models. For example, use a
            code-optimized model for technical docs and a general model for business content. Each
            collection is optimized for specific search needs.
          </DialogDescription>
        </DialogHeader>

        {hasModelOptions ? (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="model">
                Model Configuration
              </Label>
              <Select
                disabled={!hasModelOptions || creating}
                onValueChange={(value) =>
                  setFormData((prev) => ({
                    ...prev,
                    selectedModel: value,
                    name:
                      prev.name === ''
                        ? (availableModels.find((m) => m.modelKey === value)?.modelId ?? '')
                        : prev.name,
                  }))
                }
                value={formData.selectedModel}
              >
                <SelectTrigger className="w-full" id="model">
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
              {selectedModelInfo && (
                <p className="mt-2 text-muted-foreground text-xs">
                  {formatModelDescription(selectedModelInfo)}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                disabled={creating}
                id="name"
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Code Embeddings, General Purpose, etc."
                value={formData.name}
              />
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="description">
                Description
              </Label>
              <Input
                disabled={creating}
                id="description"
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Describe the purpose of this collection"
                value={formData.description}
              />
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="tags">
                Tags
              </Label>
              <Input
                disabled={creating}
                id="tags"
                onChange={(e) => setFormData((prev) => ({ ...prev, tags: e.target.value }))}
                placeholder="Comma-separated tags (e.g., code, programming, analysis)"
                value={formData.tags}
              />
              <p className="text-muted-foreground text-xs">Use commas to separate multiple tags</p>
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="category">
                Category
              </Label>
              <Input
                disabled={creating}
                id="category"
                onChange={(e) => setFormData((prev) => ({ ...prev, category: e.target.value }))}
                placeholder="e.g., development, documentation, general-text"
                value={formData.category}
              />
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-muted-foreground text-sm">
            Enable at least one embedding model in Settings to create a collection.
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={creating}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={
              creating || !hasModelOptions || !formData.selectedModel || !formData.name.trim()
            }
            onClick={handleCreate}
            type="button"
          >
            {creating ? 'Creating...' : 'Create Collection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
