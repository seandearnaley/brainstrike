import type { IEmbeddingSetsRepository } from '@brainstrike/db';
import { parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
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
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useReducer } from 'react';
import { dispatchEmbeddingSetUpdated } from '../collection-select/embedding-set-events';
import { setActiveEmbeddingSetId } from '../vector-preferences';

/**
 * Generates a unique collection name by appending a counter suffix if needed.
 *
 * Examples:
 * - "text-embedding-3-small" → "text-embedding-3-small" (if unique)
 * - "text-embedding-3-small" → "text-embedding-3-small (2)" (if collision)
 * - "text-embedding-3-small" → "text-embedding-3-small (3)" (if 2 also taken)
 */
function generateUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let counter = 2;
  let candidateName = `${baseName} (${counter})`;
  while (existingNames.has(candidateName)) {
    counter++;
    candidateName = `${baseName} (${counter})`;
  }
  return candidateName;
}

interface CreateEmbeddingSetDialogProps {
  isLoading?: boolean;
  models: ModelPickerModel[];
  onOpenChange: (open: boolean) => void;
  onSetCreated?: (setId: string) => void;
  open: boolean;
  providers: ModelPickerProvider[];
  repository: IEmbeddingSetsRepository | null;
}

function resolveSelectedEmbeddingModel(
  selectedModelInfo: ModelPickerModel | undefined
): { dimensions: number; modelId: string; modelKey: string } | null {
  if (!selectedModelInfo) {
    return null;
  }
  const parsedModelKey = parseProviderModelKey(selectedModelInfo.id);
  const modelId = selectedModelInfo.modelId ?? parsedModelKey?.modelId;
  if (!modelId) {
    return null;
  }
  return {
    modelKey: selectedModelInfo.id,
    modelId,
    dimensions: selectedModelInfo.capabilities.defaultDimension ?? 1536,
  };
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

const logger = createLogger('CreateEmbeddingSetDialog');

interface FormState {
  creating: boolean;
  existingNames: Set<string>;
  formData: {
    name: string;
    description: string;
    tags: string;
    category: string;
    selectedModel: string;
  };
  hasInitialized: boolean;
}

type FormAction =
  | { type: 'set_creating'; creating: boolean }
  | { type: 'set_form_field'; field: string; value: string }
  | { type: 'set_form_data'; formData: FormState['formData'] }
  | { type: 'set_existing_names'; names: Set<string> }
  | { type: 'set_initialized'; names: Set<string>; selectedModel: string; name: string }
  | { type: 'reset' };

const INITIAL_FORM_STATE: FormState = {
  creating: false,
  formData: { name: '', description: '', tags: '', category: '', selectedModel: '' },
  existingNames: new Set(),
  hasInitialized: false,
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'set_creating':
      return { ...state, creating: action.creating };
    case 'set_form_field':
      return { ...state, formData: { ...state.formData, [action.field]: action.value } };
    case 'set_form_data':
      return { ...state, formData: action.formData };
    case 'set_existing_names':
      return { ...state, existingNames: action.names };
    case 'set_initialized':
      return {
        ...state,
        existingNames: action.names,
        formData: { ...state.formData, selectedModel: action.selectedModel, name: action.name },
        hasInitialized: true,
      };
    case 'reset':
      return { ...INITIAL_FORM_STATE };
  }
}

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
  const [formState, dispatch] = useReducer(formReducer, INITIAL_FORM_STATE);
  const { creating, formData, existingNames, hasInitialized } = formState;

  const selectedModelInfo = models.find((m) => m.id === formData.selectedModel);
  const hasModelOptions = models.length > 0;

  // Handle dialog open/close and reset state when closing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      dispatch({ type: 'reset' });
    }
    onOpenChange(newOpen);
  };

  // Fetch existing names AND auto-fill form when dialog opens
  // Combined into single effect to avoid race conditions
  useEffect(() => {
    if (!(open && hasModelOptions) || hasInitialized) {
      return;
    }

    const firstModel = models[0];
    if (!firstModel) {
      return;
    }

    let cancelled = false;

    const initializeForm = async () => {
      // Fetch existing collection names for collision detection
      let collectionNames = new Set<string>();
      if (repository) {
        try {
          const collections = await repository.findAll();
          collectionNames = new Set(
            collections.map((c) => c.name).filter((n): n is string => n !== null)
          );
        } catch (error) {
          // Gracefully handle errors - collision detection is a nice-to-have
          logger.warn('Failed to fetch existing collection names', { error });
        }
      }

      if (cancelled) {
        return;
      }

      // Generate unique name using the model's display name
      const baseName = firstModel.name;
      const uniqueName = generateUniqueName(baseName, collectionNames);

      dispatch({
        type: 'set_initialized',
        names: collectionNames,
        selectedModel: firstModel.id,
        name: uniqueName,
      });
    };

    void initializeForm();

    return () => {
      cancelled = true;
    };
  }, [open, hasModelOptions, models, repository, hasInitialized]);

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

    const selectedModel = resolveSelectedEmbeddingModel(selectedModelInfo);
    if (!selectedModel) {
      toast({
        title: 'Error',
        description: 'Selected model metadata is invalid',
        variant: 'destructive',
      });
      return;
    }
    const { modelKey, modelId, dimensions } = selectedModel;
    const distance = 'cosine'; // Default for now

    dispatch({ type: 'set_creating', creating: true });
    let newSetId: string | null = null;
    try {
      const metadata = buildMetadata(formData);

      const newSet = await repository.getOrCreateSet(
        modelKey,
        modelId,
        dimensions,
        distance,
        metadata
      );

      newSetId = newSet.id;
      setActiveEmbeddingSetId(newSet.id);

      dispatchEmbeddingSetUpdated({
        id: newSet.id,
        reason: 'created',
        collection: {
          id: newSet.id,
          modelKey: newSet.modelKey,
          modelId: newSet.modelId,
          dimensions: newSet.dimensions,
          distance: newSet.distance,
          createdAt: newSet.createdAt,
          name: newSet.name ?? null,
          description: newSet.description ?? null,
          tags: newSet.tags ?? null,
          category: newSet.category ?? null,
          fileCount: 0,
          chunkCount: 0,
          embeddingCount: 0,
          statsAvailable: false,
          statsLastRefreshedAt: null,
        },
      });

      toast({
        title: 'Success',
        description: `Created embedding set: ${formData.name}`,
      });

      dispatch({ type: 'reset' });
      handleOpenChange(false);
    } catch (error) {
      dispatch({ type: 'set_creating', creating: false });
      logger.error('Failed to create embedding set', { error });
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create collection',
        variant: 'destructive',
      });
      return;
    }
    if (newSetId) {
      onSetCreated?.(newSetId);
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

  const canSubmit =
    !creating && hasModelOptions && Boolean(formData.selectedModel) && formData.name.trim() !== '';

  // Note: handler typed inline via the JSX prop; React 19 typings deprecate the
  // standalone FormEvent/FormEventHandler aliases.
  const handleSubmit = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    void handleCreate();
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="flex max-h-[85vh] w-[min(460px,calc(100vw-2rem))] max-w-[min(460px,calc(100vw-2rem))] flex-col gap-0 p-0 sm:max-w-[460px]">
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>Create Search Collection</DialogTitle>
          <DialogDescription>
            A collection pairs your files with one embedding model so you can search them with the
            best tool for the job.
          </DialogDescription>
        </DialogHeader>

        {hasModelOptions || isLoading ? (
          <form
            className="flex min-h-0 flex-col"
            id="create-embedding-set-form"
            onSubmit={handleSubmit}
          >
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
              <div className="space-y-2">
                <Label className="font-medium text-sm" htmlFor="model">
                  Model
                </Label>
                <ModelPicker
                  disabled={!hasModelOptions || creating || isLoading}
                  mode="single"
                  models={models}
                  modelType="embedding"
                  onChange={(value: string | string[]) => {
                    const modelKey = value as string;
                    const selectedModel = models.find((m) => m.id === modelKey);
                    // Only auto-fill name if it's empty or was auto-generated
                    const shouldAutoFillName = formData.name === '';
                    if (shouldAutoFillName && selectedModel) {
                      const uniqueName = generateUniqueName(selectedModel.name, existingNames);
                      dispatch({
                        type: 'set_form_data',
                        formData: { ...formData, selectedModel: modelKey, name: uniqueName },
                      });
                    } else {
                      dispatch({ type: 'set_form_field', field: 'selectedModel', value: modelKey });
                    }
                  }}
                  placeholder={isLoading ? 'Loading models...' : 'Select an embedding model'}
                  providers={providers}
                  searchable={false}
                  value={formData.selectedModel}
                />
                {selectedModelInfo && (
                  <p className="text-muted-foreground text-xs">
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
                  onChange={(e) =>
                    dispatch({ type: 'set_form_field', field: 'name', value: e.target.value })
                  }
                  placeholder="e.g., Code Embeddings"
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
                  onChange={(e) =>
                    dispatch({
                      type: 'set_form_field',
                      field: 'description',
                      value: e.target.value,
                    })
                  }
                  placeholder="What this collection is for"
                  value={formData.description}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-medium text-sm" htmlFor="tags">
                    Tags
                  </Label>
                  <Input
                    disabled={creating}
                    id="tags"
                    onChange={(e) =>
                      dispatch({ type: 'set_form_field', field: 'tags', value: e.target.value })
                    }
                    placeholder="code, docs, analysis"
                    value={formData.tags}
                  />
                  <p className="text-[11px] text-muted-foreground">Comma-separated</p>
                </div>

                <div className="space-y-2">
                  <Label className="font-medium text-sm" htmlFor="category">
                    Category
                  </Label>
                  <Input
                    disabled={creating}
                    id="category"
                    onChange={(e) =>
                      dispatch({
                        type: 'set_form_field',
                        field: 'category',
                        value: e.target.value,
                      })
                    }
                    placeholder="e.g., development"
                    value={formData.category}
                  />
                </div>
              </div>
            </div>

            <DialogFooter className="border-t px-6 py-4">
              <Button
                disabled={creating}
                onClick={() => handleOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!canSubmit} type="submit">
                {creating ? 'Creating...' : 'Create Collection'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <div className="px-6 py-5">
              <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-muted-foreground text-sm">
                Enable at least one embedding model in Settings to create a collection.
              </div>
            </div>
            <DialogFooter className="border-t px-6 py-4">
              <Button onClick={() => handleOpenChange(false)} type="button" variant="outline">
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
