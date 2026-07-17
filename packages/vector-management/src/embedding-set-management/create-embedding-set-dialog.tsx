import type { EmbeddingSet, IEmbeddingSetsRepository } from '@brainstrike/db';
import { parseEmbeddingProviderModelKey } from '@brainstrike/indexing-contract';
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
import { type FormEvent, useEffect, useReducer, useRef } from 'react';
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
  onSetCreated?: (setId: string, set: EmbeddingSet) => void;
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
  const parsedModelKey = parseEmbeddingProviderModelKey(selectedModelInfo.id);
  const modelId = selectedModelInfo.modelId ?? parsedModelKey?.modelId;
  if (!modelId) {
    return null;
  }
  return {
    dimensions: selectedModelInfo.capabilities.defaultDimension ?? 1536,
    modelId,
    modelKey: selectedModelInfo.id,
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

interface CreateEmbeddingSetFormData {
  category: string;
  description: string;
  name: string;
  tags: string;
}

function readSubmittedFormData(form: HTMLFormElement): CreateEmbeddingSetFormData {
  const submitted = new FormData(form);
  return {
    category: String(submitted.get('category') ?? ''),
    description: String(submitted.get('description') ?? ''),
    name: String(submitted.get('name') ?? ''),
    tags: String(submitted.get('tags') ?? ''),
  };
}

function canSubmitCreateForm(
  submittedFormData: CreateEmbeddingSetFormData,
  options: { creating: boolean; hasModelOptions: boolean; selectedModelId: string }
): boolean {
  return (
    !options.creating &&
    options.hasModelOptions &&
    options.selectedModelId !== '' &&
    submittedFormData.name.trim() !== ''
  );
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
  // True once the user has manually edited the name. Once set, model changes no
  // longer auto-rewrite the name — we respect what the user typed.
  nameDirty: boolean;
}

type FormAction =
  | { type: 'set_creating'; creating: boolean }
  | { type: 'set_field'; field: 'description' | 'tags' | 'category'; value: string }
  | { type: 'edit_name'; value: string }
  | { type: 'select_model'; modelId: string; autoName: string | null }
  | {
      type: 'refine_existing_names';
      names: Set<string>;
      baseModelId: string | null;
      baseName: string | null;
    }
  | { type: 'init_with_model'; modelId: string; name: string }
  | { type: 'reset' };

const INITIAL_FORM_STATE: FormState = {
  creating: false,
  existingNames: new Set(),
  formData: { category: '', description: '', name: '', selectedModel: '', tags: '' },
  hasInitialized: false,
  nameDirty: false,
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'set_creating':
      return { ...state, creating: action.creating };
    case 'set_field':
      return { ...state, formData: { ...state.formData, [action.field]: action.value } };
    case 'edit_name':
      // User-driven name change — flips nameDirty so future model selections won't overwrite it.
      return {
        ...state,
        formData: { ...state.formData, name: action.value },
        nameDirty: true,
      };
    case 'select_model':
      // Model picked. autoName is non-null when the user hasn't yet typed in the name field.
      return {
        ...state,
        formData: {
          ...state.formData,
          name: action.autoName ?? state.formData.name,
          selectedModel: action.modelId,
        },
      };
    case 'refine_existing_names': {
      // Async findAll() may resolve long after dispatch was queued. Re-check
      // live state here — not values captured by the effect's closure — so
      // a slow query can't clobber a name the user typed or roll back to an
      // older model the user has since switched away from.
      const next = { ...state, existingNames: action.names };
      const stillOnSameModel =
        action.baseModelId !== null && action.baseModelId === state.formData.selectedModel;
      if (state.nameDirty || !(stillOnSameModel && action.baseName)) {
        return next;
      }
      return {
        ...next,
        formData: {
          ...state.formData,
          name: generateUniqueName(action.baseName, action.names),
        },
      };
    }
    case 'init_with_model': {
      // Synchronous open-time initialization: seeds model + default name immediately.
      // If the user typed while models were still loading, keep that name.
      const hasUserProvidedName = state.nameDirty || state.formData.name.trim().length > 0;

      return {
        ...state,
        formData: {
          ...state.formData,
          name: hasUserProvidedName ? state.formData.name : action.name,
          selectedModel: action.modelId,
        },
        hasInitialized: true,
      };
    }
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
  const { creating, formData, existingNames, hasInitialized, nameDirty } = formState;
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const nameDirtyRef = useRef(false);

  const selectedModelInfo = models.find((m) => m.id === formData.selectedModel);
  const hasModelOptions = models.length > 0;

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      nameDirtyRef.current = false;
      dispatch({ type: 'reset' });
    }
    onOpenChange(newOpen);
  };

  // Phase 1 (synchronous): the moment the dialog opens with models available,
  // seed the form with the first model's id + name. This eliminates the
  // empty-then-populate flash that would otherwise show before findAll resolves.
  useEffect(() => {
    if (!(open && hasModelOptions) || hasInitialized) {
      return;
    }
    const firstModel = models[0];
    if (!firstModel) {
      return;
    }
    dispatch({
      modelId: firstModel.id,
      name: firstModel.name,
      type: 'init_with_model',
    });
  }, [open, hasModelOptions, models, hasInitialized]);

  // Phase 2 (asynchronous): refine the auto-name with collision detection by
  // querying existing collections. Runs in the background; if the user hasn't
  // typed a custom name yet, the suffix gets appended silently.
  useEffect(() => {
    if (!(open && hasInitialized && repository)) {
      return;
    }
    let cancelled = false;
    void (async () => {
      let collectionNames = new Set<string>();
      try {
        const collections = await repository.findAll();
        collectionNames = new Set(
          collections.map((c) => c.name).filter((n): n is string => n !== null)
        );
      } catch (error) {
        logger.warn('Failed to fetch existing collection names', { error });
      }
      const firstModel = models[0];
      const liveNameValue = nameInputRef.current?.value ?? '';
      if (cancelled || nameDirtyRef.current || liveNameValue !== (firstModel?.name ?? '')) {
        return;
      }
      // Hand the raw inputs to the reducer; it inspects live state at apply
      // time to decide whether the user has typed or switched models since
      // this query started, and skips the refinement if so.
      dispatch({
        baseModelId: firstModel?.id ?? null,
        baseName: firstModel?.name ?? null,
        names: collectionNames,
        type: 'refine_existing_names',
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [open, hasInitialized, repository, models]);

  const validateCreateInputs = (submittedFormData: CreateEmbeddingSetFormData): boolean => {
    if (!(repository && selectedModelInfo)) {
      toast({
        description: 'Invalid configuration',
        title: 'Error',
        variant: 'destructive',
      });
      return false;
    }

    if (!submittedFormData.name.trim()) {
      toast({
        description: 'Please provide a name for the embedding set',
        title: 'Validation Error',
        variant: 'destructive',
      });
      return false;
    }

    return true;
  };

  const handleCreate = async (submittedFormData: CreateEmbeddingSetFormData) => {
    if (!(validateCreateInputs(submittedFormData) && repository && selectedModelInfo)) {
      return;
    }

    const selectedModel = resolveSelectedEmbeddingModel(selectedModelInfo);
    if (!selectedModel) {
      toast({
        description: 'Selected model metadata is invalid',
        title: 'Error',
        variant: 'destructive',
      });
      return;
    }
    const { modelKey, modelId, dimensions } = selectedModel;
    const distance = 'cosine'; // Default for now

    dispatch({ creating: true, type: 'set_creating' });
    let createdSet: EmbeddingSet | null = null;
    try {
      const metadata = buildMetadata(submittedFormData);

      const newSet = await repository.getOrCreateSet(
        modelKey,
        modelId,
        dimensions,
        distance,
        metadata
      );

      createdSet = newSet;
      setActiveEmbeddingSetId(newSet.id);

      dispatchEmbeddingSetUpdated({
        collection: {
          category: newSet.category ?? null,
          chunkCount: 0,
          createdAt: newSet.createdAt,
          description: newSet.description ?? null,
          dimensions: newSet.dimensions,
          distance: newSet.distance,
          embeddingCount: 0,
          fileCount: 0,
          id: newSet.id,
          modelId: newSet.modelId,
          modelKey: newSet.modelKey,
          name: newSet.name ?? null,
          statsAvailable: false,
          statsLastRefreshedAt: null,
          tags: newSet.tags ?? null,
        },
        id: newSet.id,
        reason: 'created',
      });

      toast({
        description: `Created embedding set: ${metadata.name}`,
        title: 'Success',
      });

      dispatch({ type: 'reset' });
      handleOpenChange(false);
    } catch (error) {
      dispatch({ creating: false, type: 'set_creating' });
      logger.error('Failed to create embedding set', { error });
      toast({
        description: error instanceof Error ? error.message : 'Failed to create collection',
        title: 'Error',
        variant: 'destructive',
      });
      return;
    }
    if (createdSet) {
      onSetCreated?.(createdSet.id, createdSet);
    }
  };

  const canSubmit = canSubmitCreateForm(formData, {
    creating,
    hasModelOptions,
    selectedModelId: formData.selectedModel,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submittedFormData = readSubmittedFormData(event.currentTarget);
    if (
      !canSubmitCreateForm(submittedFormData, {
        creating,
        hasModelOptions,
        selectedModelId: formData.selectedModel,
      })
    ) {
      return;
    }
    void handleCreate(submittedFormData);
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] w-[min(460px,calc(100vw-2rem))] max-w-[min(460px,calc(100vw-2rem))] overflow-y-auto sm:max-w-[460px]">
        {/* pr-10 reserves a gutter for the absolutely-positioned close X so it never overlaps the title. */}
        <DialogHeader className="pr-10">
          <DialogTitle>Create Search Collection</DialogTitle>
          <DialogDescription>
            A collection pairs your files with one embedding model so you can search them with the
            best tool for the job.
          </DialogDescription>
        </DialogHeader>

        {hasModelOptions || isLoading ? (
          <form className="grid gap-5" id="create-embedding-set-form" onSubmit={handleSubmit}>
            <div className="grid gap-2">
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
                  const picked = models.find((m) => m.id === modelKey);
                  // If the user hasn't typed in the name field yet, regenerate
                  // the auto-name from the newly selected model. Otherwise
                  // preserve whatever the user typed.
                  const autoName =
                    !nameDirty && picked ? generateUniqueName(picked.name, existingNames) : null;
                  dispatch({ autoName, modelId: modelKey, type: 'select_model' });
                }}
                placeholder={isLoading ? 'Loading models...' : 'Select an embedding model'}
                providers={providers}
                searchable={false}
                value={formData.selectedModel}
              />
              <div
                className="min-h-[1.25rem] text-muted-foreground text-xs leading-5"
                data-testid="model-picker-description-slot"
              >
                {selectedModelInfo?.description ?? null}
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="font-medium text-sm" htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                disabled={creating}
                id="name"
                name="name"
                onChange={(e) => {
                  nameDirtyRef.current = true;
                  dispatch({ type: 'edit_name', value: e.target.value });
                }}
                onInputCapture={() => {
                  nameDirtyRef.current = true;
                }}
                placeholder="e.g., Code Embeddings"
                ref={nameInputRef}
                value={formData.name}
              />
            </div>

            <div className="grid gap-2">
              <Label className="font-medium text-sm" htmlFor="description">
                Description
              </Label>
              <Input
                disabled={creating}
                id="description"
                name="description"
                onChange={(e) =>
                  dispatch({ field: 'description', type: 'set_field', value: e.target.value })
                }
                placeholder="What this collection is for"
                value={formData.description}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label className="font-medium text-sm" htmlFor="tags">
                  Tags
                </Label>
                <Input
                  disabled={creating}
                  id="tags"
                  name="tags"
                  onChange={(e) =>
                    dispatch({ field: 'tags', type: 'set_field', value: e.target.value })
                  }
                  placeholder="code, docs, analysis"
                  value={formData.tags}
                />
                <p className="min-h-[1rem] text-[11px] text-muted-foreground leading-4">
                  Comma-separated
                </p>
              </div>

              <div className="grid gap-2">
                <Label className="font-medium text-sm" htmlFor="category">
                  Category
                </Label>
                <Input
                  disabled={creating}
                  id="category"
                  name="category"
                  onChange={(e) =>
                    dispatch({ field: 'category', type: 'set_field', value: e.target.value })
                  }
                  placeholder="e.g., development"
                  value={formData.category}
                />
                {/* Empty-but-reserved spacer keeps the two columns visually balanced. */}
                <div aria-hidden="true" className="min-h-[1rem]" />
              </div>
            </div>

            <DialogFooter className="pt-2">
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
            <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-muted-foreground text-sm">
              Enable at least one embedding model in Settings to create a collection.
            </div>
            <DialogFooter>
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
