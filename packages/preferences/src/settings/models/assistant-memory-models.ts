import type { RuntimeAssistantMemoryScope } from '@brainstrike/assistant-contract/memory-settings';
import type { DbModel, DbProvider } from '../../stores/model-registry-store';

export interface AssistantMemoryModelOption {
  label: string;
  modelId: string;
  providerId: string;
  providerName: string;
  target: string;
}

const OBSERVATIONAL_MEMORY_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google', 'openrouter']);
const SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS = new Set(['openai', 'google', 'cohere', 'voyage']);

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
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    target: toMastraModelTarget(provider.id, model.id),
    label: `${provider.name} · ${model.name}`,
  };
}

export function listObservationalMemoryModelOptions(args: {
  models: readonly DbModel[];
  providers: readonly DbProvider[];
}): readonly AssistantMemoryModelOption[] {
  const providers = providerById(args.providers);
  return args.models
    .filter((model) => {
      const provider = providers.get(model.providerId);
      return (
        OBSERVATIONAL_MEMORY_PROVIDER_IDS.has(model.providerId) &&
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
  providers: readonly DbProvider[];
}): readonly AssistantMemoryModelOption[] {
  const providers = providerById(args.providers);
  return args.models
    .filter((model) => {
      const provider = providers.get(model.providerId);
      return (
        SEMANTIC_RECALL_EMBEDDING_PROVIDER_IDS.has(model.providerId) &&
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
