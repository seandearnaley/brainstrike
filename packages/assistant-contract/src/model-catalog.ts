import type { ProviderModelDefaultPolicy } from './provider-model-default-policies.js';
import {
  listProviders,
  type ProviderDefinition,
  type ProviderModelDefinition,
} from './provider-registry.js';

export interface CatalogProvider {
  icon: string | null;
  id: string;
  isEnabled: boolean;
  name: string;
  sortOrder: number;
}

export interface CatalogModel {
  bestFor: string[] | null;
  capabilities: {
    type: 'llm' | 'embedding';
    streaming?: boolean;
    defaultDimension?: number;
    /** A local embedding model's pooling (BST-1993); absent means 'mean'. */
    pooling?: 'mean' | 'cls';
    /** A local embedding model's card prompts (BST-1993); absent means none. */
    prompts?: { document: string; query: string };
    /** Image-input support (LLM rows only; backfilled by migration 061). */
    vision?: boolean;
  };
  description: string | null;
  icon: string | null;
  id: string;
  isEnabled: boolean;
  name: string;
  parameters: Record<string, unknown> | null;
  providerId: string;
  sortOrder: number;
  tagline: string | null;
}

export interface ModelCatalogSnapshot {
  readonly models: readonly CatalogModel[];
  readonly providers: readonly CatalogProvider[];
}

export interface ModelCatalogCapability {
  initializeProviderDefaults(
    providerId: string,
    policy: ProviderModelDefaultPolicy
  ): Promise<{
    readonly snapshot: ModelCatalogSnapshot;
    readonly outcome: 'initialized' | 'preserved';
  }>;
  read(): Promise<ModelCatalogSnapshot>;
  setModels(
    modelIds: readonly string[],
    enabled: boolean
  ): Promise<{
    readonly snapshot: ModelCatalogSnapshot;
    readonly previous: readonly { readonly modelId: string; readonly enabled: boolean }[];
  }>;
  setProvider(providerId: string, enabled: boolean): Promise<ModelCatalogSnapshot>;
}

/** Mutable choices are owned by the platform's durable writer; metadata is this catalog. */
export interface ModelCatalogChoices {
  readonly models: readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly enabled: boolean;
  }[];
  readonly providers: readonly { readonly providerId: string; readonly enabled: boolean }[];
}

function projectModel(
  provider: ProviderDefinition,
  model: ProviderModelDefinition,
  choices: ModelCatalogChoices
): CatalogModel {
  const presentation = model.catalog;
  if (!presentation) {
    throw new Error(`Model ${provider.id}/${model.id} has no catalog presentation.`);
  }
  const parameters = {
    ...presentation.parameters,
    ...(model.type === 'embedding' && model.revision ? { revision: model.revision } : {}),
    ...(model.type === 'embedding' && model.execution ? { execution: model.execution } : {}),
  };
  return {
    bestFor: presentation.bestFor ? [...presentation.bestFor] : null,
    capabilities:
      model.type === 'embedding'
        ? {
            defaultDimension: model.defaultDimension,
            type: 'embedding',
            ...(model.pooling === undefined ? {} : { pooling: model.pooling }),
            ...(model.prompts === undefined ? {} : { prompts: model.prompts }),
          }
        : {
            streaming: model.supportsStreaming ?? provider.capabilities.streaming,
            type: 'llm',
            vision: model.vision === 'supported',
            ...presentation.capabilities,
          },
    description: presentation.description,
    icon: presentation.icon,
    id: model.id,
    isEnabled:
      choices.models.find(
        (choice) => choice.providerId === provider.id && choice.modelId === model.id
      )?.enabled ?? presentation.enabled,
    name: presentation.name,
    parameters: Object.keys(parameters).length > 0 ? parameters : null,
    providerId: provider.id,
    sortOrder: presentation.sortOrder,
    tagline: presentation.tagline,
  };
}

/** A complete current catalog projection; keyless runtime-discovered providers have no static rows. */
export function projectModelCatalog(choices: ModelCatalogChoices): ModelCatalogSnapshot {
  const definitions = listProviders();
  const providers = definitions.flatMap((provider) =>
    provider.catalog
      ? [
          {
            icon: provider.catalog.icon,
            id: provider.id,
            isEnabled:
              choices.providers.find((choice) => choice.providerId === provider.id)?.enabled ??
              provider.catalog.enabled,
            name: provider.catalog.name,
            sortOrder: provider.catalog.sortOrder,
          },
        ]
      : []
  );
  const models = definitions.flatMap((provider) =>
    provider.models.map((model) => projectModel(provider, model, choices))
  );
  return {
    models: models.sort((a, b) => a.sortOrder - b.sortOrder),
    providers: providers.sort((a, b) => a.sortOrder - b.sortOrder),
  };
}
