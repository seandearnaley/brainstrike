import type { DbModel, DbProvider } from '@brainstrike/app-state/stores/model-registry-store';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { RuntimeAssistantMemoryScope } from '@brainstrike/assistant-contract/memory-settings';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';

export interface AssistantMemoryModelOption {
  label: string;
  modelId: string;
  providerId: string;
  providerName: string;
  target: string;
}

// The assistant server allows the same provider set. All four need a key:
// the built-in on-device provider is embeddings-only, so there is no longer a
// keyless observer.
const OBSERVATIONAL_MEMORY_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'openrouter']);
// 'local' embedders run in the hidden embedding-host renderer, proxied for
// Mastra semantic recall by the assistant server (no API key).
const SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS = new Set(['openai', 'google', 'local']);

function providerById(providers: readonly DbProvider[]): Map<string, DbProvider> {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

function isEnabledProvider(provider: DbProvider | undefined): provider is DbProvider {
  return provider?.isEnabled === true;
}

function compareOptions(providers: Map<string, DbProvider>, left: DbModel, right: DbModel): number {
  const leftProvider = providers.get(left.providerId);
  const rightProvider = providers.get(right.providerId);
  return (
    (leftProvider?.sortOrder ?? 0) - (rightProvider?.sortOrder ?? 0) ||
    left.sortOrder - right.sortOrder ||
    left.name.localeCompare(right.name)
  );
}

export function toMastraModelTarget(providerId: string, modelId: string): string {
  if (providerId === 'openrouter') {
    return `openrouter/${modelId}`;
  }
  return `${providerId}/${modelId}`;
}

function toOption(provider: DbProvider, model: DbModel): AssistantMemoryModelOption {
  return {
    label: `${provider.name} · ${model.name}`,
    modelId: model.id,
    providerId: provider.id,
    providerName: provider.name,
    target: toMastraModelTarget(provider.id, model.id),
  };
}

/**
 * Observational memory needs the durable memory backend to record anything, so
 * `assistantMemoryBackendAvailable` gates every candidate rather than only the
 * keyless one it used to gate (the built-in on-device chat model, now retired).
 * That matches `resolveEffectiveObservationalMemorySettings`, where a missing
 * backend is the 'no-backend' unresolved reason for all providers.
 */
export function listObservationalMemoryModelOptions(args: {
  assistantMemoryBackendAvailable: boolean;
  models: readonly DbModel[];
  providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  providers: readonly DbProvider[];
}): readonly AssistantMemoryModelOption[] {
  const providers = providerById(args.providers);
  const providersWithKeys = new Set<string>(
    (args.providerKeySources ?? []).map(({ provider }) => provider)
  );
  return args.models
    .filter((model) => {
      const provider = providers.get(model.providerId);
      return (
        args.assistantMemoryBackendAvailable &&
        OBSERVATIONAL_MEMORY_PROVIDER_IDS.has(model.providerId) &&
        (args.providerKeySources === undefined || providersWithKeys.has(model.providerId)) &&
        isEnabledProvider(provider) &&
        model.isEnabled &&
        model.capabilities.type === 'llm'
      );
    })
    .sort((left, right) => compareOptions(providers, left, right))
    .map((model) => toOption(providers.get(model.providerId) as DbProvider, model));
}

export function listSemanticRecallEmbeddingModelOptions(args: {
  models: readonly DbModel[];
  providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  providers: readonly DbProvider[];
}): readonly AssistantMemoryModelOption[] {
  const providers = providerById(args.providers);
  const providersWithKeys = new Set<string>(
    (args.providerKeySources ?? []).map(({ provider }) => provider)
  );
  return args.models
    .filter((model) => {
      const provider = providers.get(model.providerId);
      return (
        SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS.has(model.providerId) &&
        (args.providerKeySources === undefined ||
          model.providerId === 'local' ||
          providersWithKeys.has(model.providerId)) &&
        isEnabledProvider(provider) &&
        model.isEnabled &&
        model.capabilities.type === 'embedding' &&
        typeof model.capabilities.defaultDimension === 'number'
      );
    })
    .sort((left, right) => compareOptions(providers, left, right))
    .map((model) => toOption(providers.get(model.providerId) as DbProvider, model));
}

export function formatMemoryScopeLabel(scope: RuntimeAssistantMemoryScope): string {
  return scope === 'resource' ? 'Workspace' : 'Thread';
}
