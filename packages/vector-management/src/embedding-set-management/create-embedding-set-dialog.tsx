import type { DrizzleEmbeddingSetsRepository } from '@brainstrike/db';
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
  ModelPicker,
  type ModelPickerModel,
  type ModelPickerProvider,
  useToast,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useEffect, useState } from 'react';
import { setActiveEmbeddingSetId } from '../vector-preferences';

type CreateEmbeddingSetDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repository: DrizzleEmbeddingSetsRepository | null;
  models: ModelPickerModel[];
  providers: ModelPickerProvider[];
  isLoading?: boolean;
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
  models,
  providers,
  isLoading = false,
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

  const selectedModelInfo = models.find((m) => m.id === formData.selectedModel);
  const hasModelOptions = models.length > 0;

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
    setFormData((prev) => ({ ...prev, selectedModel: models[0]?.id ?? '' }));
  }, [open, hasModelOptions, models, formData.selectedModel]);

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

      // Reconstruct modelKey and dimensions from ModelPickerModel
      const modelKey = selectedModelInfo.id; // id is the modelKey (e.g. "openai::text-embedding-3-small")
      const modelId = selectedModelInfo.name; // name is the modelId (e.g. "text-embedding-3-small")
      const dimensions = selectedModelInfo.capabilities.defaultDimension ?? 1536; // Fallback if missing
      const distance = 'cosine'; // Default for now

      const newSet = await repository.getOrCreateSet(
        modelKey,
        modelId,
        dimensions,
        distance,
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

  const formatModelDescription = (model: ModelPickerModel) => {
    const parts: string[] = [];

    // Add cost indicator
    if (model.pricePer1MTokensInput !== undefined) {
      parts.push(`💰 $${model.pricePer1MTokensInput.toFixed(2)}/1M tokens`);
    } else if (model.providerId === 'local' || model.providerId === 'transformers') {
      parts.push('🔒 Free (local)');
    }

    // Add model description if available
    if (model.description) {
      parts.push(model.description);
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

        {hasModelOptions || isLoading ? (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="font-medium text-sm" htmlFor="model">
                Model Configuration
              </Label>
              <ModelPicker
                disabled={!hasModelOptions || creating || isLoading}
                mode="single"
                models={models}
                modelType="embedding"
                onChange={(value: string | string[]) => {
                  const modelKey = value as string;
                  setFormData((prev) => ({
                    ...prev,
                    selectedModel: modelKey,
                    name:
                      prev.name === ''
                        ? (models.find((m) => m.id === modelKey)?.name ?? '')
                        : prev.name,
                  }));
                }}
                placeholder={isLoading ? 'Loading models...' : 'Select an embedding model'}
                providers={providers}
                searchable={false}
                value={formData.selectedModel}
              />
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
