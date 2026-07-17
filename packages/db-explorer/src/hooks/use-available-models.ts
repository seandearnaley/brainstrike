import type {
  LoadedRuntimeModelCatalogState,
  LocalRuntimeId,
  LocalRuntimeModelCatalogState,
} from '@brainstrike/assistant-contract/local-runtime';
import { isLoadedRuntimeModelCatalogState } from '@brainstrike/assistant-contract/local-runtime';
import type { DbModel, DbProvider } from '@brainstrike/preferences/stores/model-registry-store';
import { formatProviderModelKey } from '@brainstrike/utils';
import { useMemo } from 'react';

interface AvailableModel {
  // Picker-dialect capabilities: the DB catalog stores `vision` as a boolean
  // jsonb flag while ModelPickerModel expects the tri-state; translated in
  // useAvailableModels (moot for the embedding-only rows this hook surfaces,
  // but keeps the shapes honest instead of casting).
  capabilities: Omit<DbModel['capabilities'], 'vision'> & {
    vision?: 'supported' | 'unsupported' | 'unknown';
  };
  description: string;
  id: string;
  modelId: string;
  name: string;
  pricePer1MTokensInput?: number;
  providerId: string;
}

interface AvailableProvider {
  icon: string | null;
  id: string;
  name: string;
}

type LocalRuntimeModelCatalogMap = Partial<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>>;

const LOCAL_RUNTIME_PROVIDER_METADATA: Record<
  LocalRuntimeId,
  Readonly<{ name: string; icon: null }>
> = {
  lmstudio: { icon: null, name: 'LM Studio' },
  ollama: { icon: null, name: 'Ollama' },
} as const;

function resolveKnownDimension(
  model: LoadedRuntimeModelCatalogState['models'][number]
): number | null {
  if (model.dimensionsKnown.state !== 'known') {
    return null;
  }
  const candidate = model.dimensionsKnown.values[0];
  if (!(typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0)) {
    return null;
  }
  return candidate;
}

function toPickerCapabilities(
  capabilities: DbModel['capabilities']
): AvailableModel['capabilities'] {
  const { vision, ...rest } = capabilities;
  return {
    ...rest,
    ...(vision === undefined
      ? {}
      : { vision: vision ? ('supported' as const) : ('unsupported' as const) }),
  };
}

function toRuntimeEmbeddingModels(catalog: LocalRuntimeModelCatalogMap | null): AvailableModel[] {
  if (!catalog) {
    return [];
  }

  const runtimeModels: AvailableModel[] = [];
  for (const runtimeId of Object.keys(LOCAL_RUNTIME_PROVIDER_METADATA) as LocalRuntimeId[]) {
    const state = catalog[runtimeId];
    if (!isLoadedRuntimeModelCatalogState(state)) {
      continue;
    }
    for (const model of state.models) {
      if (model.capabilities.embeddings !== 'supported') {
        continue;
      }
      const knownDimension = resolveKnownDimension(model);
      if (knownDimension === null) {
        // Create-set flow requires deterministic dimensions for schema creation.
        continue;
      }

      runtimeModels.push({
        capabilities: {
          defaultDimension: knownDimension,
          type: 'embedding',
        },
        description:
          model.displayName === model.modelId
            ? `${knownDimension}D • Local runtime`
            : `${model.displayName} • ${knownDimension}D • Local runtime`,
        id: model.modelKey,
        modelId: model.modelId,
        name: model.modelId,
        providerId: runtimeId,
      });
    }
  }

  return runtimeModels;
}

function hasRuntimeProviderModels(
  catalog: LocalRuntimeModelCatalogMap | null,
  runtimeId: LocalRuntimeId
): boolean {
  if (!catalog) {
    return false;
  }
  const state = catalog[runtimeId];
  if (!isLoadedRuntimeModelCatalogState(state)) {
    return false;
  }
  return state.models.some(
    (model) =>
      model.capabilities.embeddings === 'supported' && resolveKnownDimension(model) !== null
  );
}

/**
 * Transforms registered models into available embedding models for UI.
 */
export function useAvailableModels(
  models: DbModel[],
  runtimeCatalog: LocalRuntimeModelCatalogMap | null = null
): AvailableModel[] {
  return useMemo(() => {
    const registryModels = models
      .filter((m) => m.isEnabled && m.capabilities.type === 'embedding')
      .map((m) => ({
        capabilities: toPickerCapabilities(m.capabilities),
        description: m.description ?? '',
        id: formatProviderModelKey(m.providerId, m.id),
        modelId: m.id,
        name: m.name,
        providerId: m.providerId,
        ...(m.parameters && 'pricePer1MTokens' in m.parameters
          ? {
              pricePer1MTokensInput: (m.parameters as { pricePer1MTokens: number })
                .pricePer1MTokens,
            }
          : {}),
      }));

    const runtimeModels = toRuntimeEmbeddingModels(runtimeCatalog);
    if (runtimeModels.length === 0) {
      return registryModels;
    }

    // Runtime models can overlap by provider/model with registry-backed entries.
    // Prefer runtime-discovered entries because they carry verified dimensions.
    const merged = new Map<string, AvailableModel>();
    for (const model of registryModels) {
      merged.set(model.id, model);
    }
    for (const model of runtimeModels) {
      const registryModel = merged.get(model.id);
      if (
        registryModel &&
        typeof registryModel.pricePer1MTokensInput === 'number' &&
        typeof model.pricePer1MTokensInput !== 'number'
      ) {
        merged.set(model.id, {
          ...model,
          pricePer1MTokensInput: registryModel.pricePer1MTokensInput,
        });
        continue;
      }
      merged.set(model.id, model);
    }
    return Array.from(merged.values());
  }, [models, runtimeCatalog]);
}

/**
 * Transforms registered providers into available providers for UI.
 */
export function useAvailableProviders(
  providers: DbProvider[],
  runtimeCatalog: LocalRuntimeModelCatalogMap | null = null
): AvailableProvider[] {
  return useMemo(() => {
    const registryProviders = providers
      .filter((p) => p.isEnabled)
      .map((p) => ({
        icon: p.icon,
        id: p.id,
        name: p.name,
      }));

    const merged = new Map<string, AvailableProvider>(
      registryProviders.map((provider) => [provider.id, provider])
    );

    for (const runtimeId of Object.keys(LOCAL_RUNTIME_PROVIDER_METADATA) as LocalRuntimeId[]) {
      if (!hasRuntimeProviderModels(runtimeCatalog, runtimeId)) {
        continue;
      }
      if (merged.has(runtimeId)) {
        continue;
      }
      const metadata = LOCAL_RUNTIME_PROVIDER_METADATA[runtimeId];
      merged.set(runtimeId, { icon: metadata.icon, id: runtimeId, name: metadata.name });
    }

    return Array.from(merged.values());
  }, [providers, runtimeCatalog]);
}

export type { AvailableModel, AvailableProvider };
