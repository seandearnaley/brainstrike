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
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
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
        runtime,
        label: RUNTIME_LABELS[runtime] ?? runtime,
        providers: [],
      });
    });

    for (const providerId of configuredProviders) {
      const definition = getProviderDefinition(providerId);
      const runtime = definition.runtime;
      const modelDefinitions = getProviderLlmModels(providerId);

      const models = modelDefinitions.map((model: LlmProviderModelDefinition) => ({
        id: model.id,
        label: model.label ?? model.id,
        type: 'llm' as const,
        enabled: isModelEnabled(providerId, model.id),
        default: Boolean(model.default),
        supportsStreaming: Boolean(model.supportsStreaming),
      }));

      const group = groups.get(runtime);
      if (!group) {
        continue;
      }

      group.providers.push({
        id: providerId,
        name: definition.displayName,
        runtime,
        capabilities: {
          ...definition.capabilities,
          supportsStandardEmbeddingDimension: supportsStandardEmbeddingDimension(providerId),
        },
        models,
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
          id: providerId,
          name: definition.displayName,
          icon: null,
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
          id: model.id,
          providerId,
          name: model.label ?? model.id,
          description: null,
          contextWindow: model.contextWindow,
          capabilities: {
            type: 'llm',
            streaming: model.supportsStreaming ?? false,
          },
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
