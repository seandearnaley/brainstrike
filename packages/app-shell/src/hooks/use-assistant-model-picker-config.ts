import { resolveModelReasoningSupport } from '@brainstrike/assistant-contract/model-reasoning';
import {
  getProviderDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '@brainstrike/assistant-contract/provider-metadata';
import type {
  ModelPickerModel,
  ModelPickerProvider,
  ProviderGroupConfig,
} from '@brainstrike/ui/assistant-ui-panel';
import { useMemo } from 'react';
import type { LlmProviderModelDefinition } from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantModelPickerConfigArgs {
  readonly configuredProviders: readonly SupportedProvider[];
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  readonly isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
}

interface UseAssistantModelPickerConfigResult {
  readonly pickerModels: ModelPickerModel[];
  readonly pickerProviders: ModelPickerProvider[];
  readonly providerGroups: ProviderGroupConfig[];
}

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  browser: 'Browser',
  gateway: 'Gateway',
  hosted: 'Hosted',
  local: 'Local',
};

const runtimeOrder: readonly ProviderRuntime[] = ['hosted', 'gateway', 'local', 'browser'];

export function useAssistantModelPickerConfig({
  configuredProviders,
  getProviderLlmModels,
  isModelEnabled,
}: UseAssistantModelPickerConfigArgs): UseAssistantModelPickerConfigResult {
  const providerGroups = useMemo<ProviderGroupConfig[]>(() => {
    const groups = new Map<ProviderRuntime, ProviderGroupConfig>();

    runtimeOrder.forEach((runtime) => {
      groups.set(runtime, {
        label: RUNTIME_LABELS[runtime] ?? runtime,
        providers: [],
        runtime,
      });
    });

    for (const providerId of configuredProviders) {
      const definition = getProviderDefinition(providerId);
      const runtime = definition.runtime;
      const modelDefinitions = getProviderLlmModels(providerId);

      const models = modelDefinitions.map((model: LlmProviderModelDefinition) => ({
        default: Boolean(model.default),
        enabled: isModelEnabled(providerId, model.id),
        id: model.id,
        label: model.label ?? model.id,
        supportsStreaming: Boolean(model.supportsStreaming),
        type: 'llm' as const,
      }));

      const group = groups.get(runtime);
      if (!group) {
        continue;
      }

      group.providers.push({
        capabilities: {
          ...definition.capabilities,
          supportsStandardEmbeddingDimension: supportsStandardEmbeddingDimension(providerId),
        },
        id: providerId,
        models,
        name: definition.displayName,
        runtime,
      });
    }

    return runtimeOrder
      .map((runtime) => groups.get(runtime))
      .filter((group): group is ProviderGroupConfig =>
        Boolean(group && group.providers.length > 0)
      );
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

  const pickerProviders = useMemo<ModelPickerProvider[]>(
    () =>
      configuredProviders.map((providerId) => {
        const definition = getProviderDefinition(providerId);
        return {
          icon: null,
          id: providerId,
          name: definition.displayName,
        };
      }),
    [configuredProviders]
  );

  const pickerModels = useMemo<ModelPickerModel[]>(() => {
    const models: ModelPickerModel[] = [];

    for (const providerId of configuredProviders) {
      const modelDefinitions = getProviderLlmModels(providerId);

      for (const model of modelDefinitions) {
        if (!isModelEnabled(providerId, model.id)) {
          continue;
        }

        models.push({
          capabilities: {
            reasoning: resolveModelReasoningSupport(providerId, model.id).state,
            streaming: model.supportsStreaming ?? false,
            type: 'llm',
            vision: model.vision,
          },
          contextWindow: model.contextWindow,
          description: model.tagline ?? null,
          id: model.id,
          name: model.label ?? model.id,
          providerId,
        });
      }
    }

    return models;
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

  return {
    pickerModels,
    pickerProviders,
    providerGroups,
  };
}
