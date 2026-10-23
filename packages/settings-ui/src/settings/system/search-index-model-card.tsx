import {
  useAvailableModels,
  useAvailableProviders,
} from '@brainstrike/app-state/hooks/use-available-embedding-models';
import { useLocalRuntimeEmbeddingModelCatalog } from '@brainstrike/app-state/hooks/use-local-runtime-embedding-model-catalog';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import {
  decodeIndexLocalExecution,
  type IndexModel,
  indexModelId,
  indexModelLocalSelection,
} from '@brainstrike/assistant-contract/index-config';
import {
  type EmbeddingModelDefinition,
  findProviderDefinition,
} from '@brainstrike/assistant-contract/provider-registry';
import {
  type CatalogEmbeddingModel,
  decodeCatalogEmbeddingModel,
  type LocalExecutionCapability,
  parseEmbeddingProviderModelKey,
  type WebGpuAdapterAvailability,
} from '@brainstrike/indexing-contract';
import type { NativeLocalSelection } from '@brainstrike/indexing-contract/indexer-producer';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  ModelPicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { useMemo, useState } from 'react';
import { useWebGpuAvailability } from './use-webgpu-availability';

/** The chosen model as the helpers below read it. */
interface ModelIdentity {
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelKey: string;
}

type RecommendedExecution = NonNullable<EmbeddingModelDefinition['recommendedExecution']>;

/** The static catalog definition of an embedding model, if the catalog lists it. */
function findEmbeddingDefinition(
  providerId: string,
  modelId: string
): EmbeddingModelDefinition | undefined {
  const definition = findProviderDefinition(providerId)?.models.find(
    (model) => model.id === modelId
  );
  return definition?.type === 'embedding' ? definition : undefined;
}

/** The enabled model the static catalog recommends for this host's execution device. */
function recommendLocalModel<T extends { readonly modelId: string; readonly providerId: string }>(
  models: readonly T[],
  webgpu: WebGpuAdapterAvailability
): (T & { readonly execution: RecommendedExecution }) | null {
  const device = webgpu.available ? 'webgpu' : 'wasm';
  for (const model of models) {
    const execution = findEmbeddingDefinition(
      model.providerId,
      model.modelId
    )?.recommendedExecution;
    if (execution?.device === device) {
      return { ...model, execution };
    }
  }
  return null;
}

function executionLabel(execution: {
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: string;
}): string {
  return `${EXECUTION_LABELS[execution.device]} · ${execution.dtype.toUpperCase()}`;
}

/** The selected local collection's catalog row; a malformed row is reported, never guessed. */
function readLocalCatalogModel(
  models: readonly DbModel[],
  collection: ModelIdentity | null
): { readonly error: string | null; readonly model: CatalogEmbeddingModel | null } {
  const provider = collection
    ? parseEmbeddingProviderModelKey(collection.modelKey)?.provider
    : undefined;
  const row =
    collection && (provider === 'local' || provider === 'transformers')
      ? models.find(
          (model) => model.id === collection.modelId && model.capabilities.type === 'embedding'
        )
      : undefined;
  if (!row) {
    return { error: null, model: null };
  }
  try {
    return { error: null, model: decodeCatalogEmbeddingModel(row) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), model: null };
  }
}

const EXECUTION_LABELS: Record<'webgpu' | 'wasm', string> = { wasm: 'WASM', webgpu: 'WebGPU' };

/** Each offered plan's measured cost, as the static catalog states it (BST-1993). */
function executionNotes(
  collection: ModelIdentity | null,
  plans: readonly { readonly label: string; readonly selection: NativeLocalSelection }[]
): readonly string[] {
  const provider = collection
    ? parseEmbeddingProviderModelKey(collection.modelKey)?.provider
    : undefined;
  const notes =
    collection && provider
      ? findEmbeddingDefinition(provider, collection.modelId)?.executionNotes
      : undefined;
  return plans.flatMap(({ label, selection }) => {
    const note = notes?.[selection.device];
    return note ? [`${label}: ${note}`] : [];
  });
}

function getNativeLocalPlans(
  collection: ModelIdentity,
  current: NativeLocalSelection | null,
  catalog: CatalogEmbeddingModel | null
): readonly {
  readonly label: string;
  readonly selection: NativeLocalSelection;
}[] {
  const provider = parseEmbeddingProviderModelKey(collection.modelKey)?.provider;
  if (provider !== 'local' && provider !== 'transformers') {
    return [];
  }
  // BST-1993: a catalog row that states its execution offers exactly those plans, at its pin.
  if (catalog?.execution) {
    return (['webgpu', 'wasm'] as const).flatMap((device) => {
      const dtype = catalog.execution?.[device];
      return dtype
        ? [
            {
              label: `${EXECUTION_LABELS[device]} · ${dtype.toUpperCase()}`,
              selection: {
                device,
                dimensions: collection.dimensions,
                dtype,
                modelId: collection.modelId,
                ...(catalog.revision === undefined ? {} : { revision: catalog.revision }),
              },
            },
          ]
        : [];
    });
  }
  const choices: readonly {
    device: 'webgpu' | 'wasm';
    dtype: NativeLocalSelection['dtype'];
    label: string;
  }[] = [
    { device: 'webgpu', dtype: 'fp16', label: 'WebGPU · FP16' },
    { device: 'webgpu', dtype: 'fp32', label: 'WebGPU · FP32' },
    { device: 'webgpu', dtype: 'q4', label: 'WebGPU · Q4' },
    { device: 'webgpu', dtype: 'q8', label: 'WebGPU · Q8' },
    { device: 'wasm', dtype: 'fp32', label: 'WASM · FP32' },
    { device: 'wasm', dtype: 'q4', label: 'WASM · Q4' },
    { device: 'wasm', dtype: 'q8', label: 'WASM · Q8' },
  ];
  return choices.map(({ device, dtype, label }) => ({
    label,
    selection: {
      device,
      dimensions: collection.dimensions,
      dtype,
      modelId: collection.modelId,
      ...(current?.modelId === collection.modelId &&
      current.dimensions === collection.dimensions &&
      current.revision
        ? { revision: current.revision }
        : {}),
    },
  }));
}

const isLocalProvider = (modelKey: string): boolean => {
  const provider = parseEmbeddingProviderModelKey(modelKey)?.provider;
  return provider === 'local' || provider === 'transformers';
};

/** An on-device model runs only on an execution the user chose; the index never picks one. */
export function modelNeedsExecution(model: IndexModel | null): boolean {
  return model !== null && model.local === null && isLocalProvider(model.modelKey);
}

export function SearchIndexModelCard({
  disabled,
  localExecution,
  model,
  onChange,
}: {
  readonly disabled: boolean;
  readonly localExecution: LocalExecutionCapability | undefined;
  readonly model: IndexModel | null;
  readonly onChange: (model: IndexModel) => void;
}) {
  const registryError = useEnsureModelRegistry();
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const runtime = useLocalRuntimeEmbeddingModelCatalog({
    maxVerificationModels: 8,
    verifyEmbeddingDimensions: true,
  });
  const availableModels = useAvailableModels(models, runtime.catalog);
  const availableProviders = useAvailableProviders(providers, runtime.catalog);
  const webgpu = useWebGpuAvailability(localExecution);
  const recommended =
    webgpu.kind === 'known' ? recommendLocalModel(availableModels, webgpu.availability) : null;
  const [unverified, setUnverified] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const identity: ModelIdentity | null = useMemo(
    () =>
      model
        ? { dimensions: model.dimensions, modelId: indexModelId(model), modelKey: model.modelKey }
        : null,
    [model]
  );
  const catalog = useMemo(() => readLocalCatalogModel(models, identity), [models, identity]);
  const plans = identity
    ? getNativeLocalPlans(identity, model ? indexModelLocalSelection(model) : null, catalog.model)
    : [];
  const chosenPlan = plans.find(
    ({ selection }) =>
      model?.local?.device === selection.device &&
      model.local.dtype === selection.dtype &&
      model.local.revision === selection.revision
  );
  const choose = (modelKey: string): void => {
    const choice = availableModels.find((candidate) => candidate.id === modelKey);
    const dimensions = choice?.capabilities.defaultDimension;
    if (
      !choice ||
      typeof dimensions !== 'number' ||
      !Number.isInteger(dimensions) ||
      dimensions <= 0
    ) {
      setUnverified(choice?.name ?? modelKey);
      return;
    }
    setUnverified(null);
    setPlanError(null);
    onChange({ dimensions, local: null, modelKey: choice.id });
  };
  /** The config's own rule decides whether a plan can run; a refusal is shown, never replaced. */
  const choosePlan = (label: string): void => {
    const plan = plans.find((candidate) => candidate.label === label);
    if (!(model && plan)) {
      return;
    }
    try {
      const local = decodeIndexLocalExecution({
        device: plan.selection.device,
        dtype: plan.selection.dtype,
        ...(plan.selection.revision === undefined ? {} : { revision: plan.selection.revision }),
      });
      setPlanError(null);
      onChange({ ...model, local });
    } catch {
      setPlanError(`The search index can't run this model on ${plan.label}.`);
    }
  };
  const selectedName =
    availableModels.find((candidate) => candidate.id === model?.modelKey)?.name ?? model?.modelKey;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedding model</CardTitle>
        <CardDescription>Changing it re-embeds every chunk.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {recommended ? (
          <p className="text-muted-foreground text-sm" role="note">
            <span className="font-medium text-foreground">
              Recommended: {recommended.name} ({executionLabel(recommended.execution)}).
            </span>{' '}
            {recommended.execution.reason}
          </p>
        ) : null}
        <ModelPicker
          disabled={disabled}
          mode="single"
          models={availableModels}
          modelType="embedding"
          onChange={(value) => {
            if (typeof value === 'string') {
              choose(value);
            }
          }}
          providers={availableProviders}
          renderTrigger={() => (
            <Button
              aria-label="Embedding model"
              disabled={disabled}
              role="combobox"
              type="button"
              variant="outline"
            >
              {selectedName ?? 'Choose an embedding model'}
            </Button>
          )}
          value={model?.modelKey ?? ''}
        />
        {unverified ? (
          <p className="text-destructive text-sm" role="alert">
            {unverified} has no verified embedding dimensions. Download it in Model Catalog first.
          </p>
        ) : null}
        {model && plans.length > 0 ? (
          <div className="space-y-2">
            <Label htmlFor="search-index-execution">Run it on</Label>
            <Select onValueChange={choosePlan} value={chosenPlan?.label ?? ''}>
              <SelectTrigger aria-label="Run it on" id="search-index-execution">
                <SelectValue placeholder="Choose how to run it" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan.label} value={plan.label}>
                    {plan.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {planError ? (
              <p className="text-destructive text-sm" role="alert">
                {planError}
              </p>
            ) : null}
            {executionNotes(identity, plans).map((note) => (
              <p className="text-muted-foreground text-sm" key={note}>
                {note}
              </p>
            ))}
          </div>
        ) : null}
        {webgpu.kind === 'failed' ? (
          <p className="text-destructive text-sm" role="alert">
            Couldn't detect WebGPU.
          </p>
        ) : null}
        {catalog.error || registryError || runtime.error ? (
          <p className="text-destructive text-sm" role="alert">
            {catalog.error ?? registryError ?? runtime.error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
