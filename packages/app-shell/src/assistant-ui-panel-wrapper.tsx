import {
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ProviderModelDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '@brainstrike/agent/client';
import { useAssistantPreferencesStore } from '@brainstrike/preferences';
import { AssistantUiPanel, type ProviderGroupConfig } from '@brainstrike/ui/assistant-ui-panel';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';

export interface AssistantUiPanelWrapperProps {
  className?: string;
}

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = () => {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>([]);

  const {
    selectedProvider,
    enabledModelsByProvider,
    setProvider,
    clearProvider,
    setModel,
    setModelEnabled,
    getAvailableProviders,
    getSelectedModel,
  } = useAssistantPreferencesStore();

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => (enabledModelsByProvider[provider] ?? []).length > 0,
    [enabledModelsByProvider]
  );

  const reconcileSelection = useCallback(
    (providers: SupportedProvider[]) => {
      if (selectedProvider && !providers.includes(selectedProvider)) {
        clearProvider();
        return;
      }

      if (selectedProvider && providerHasEnabledModels(selectedProvider)) {
        return;
      }

      const next = providers.find((providerId) => providerHasEnabledModels(providerId));
      if (next) {
        setProvider(next);
        return;
      }

      if (selectedProvider) {
        clearProvider();
      }
    },
    [selectedProvider, clearProvider, setProvider, providerHasEnabledModels]
  );

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      const providers = await getAvailableProviders();
      if (cancelled) return;

      setConfiguredProviders(providers);
      reconcileSelection(providers);
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
  }, [getAvailableProviders, reconcileSelection]);

  useEffect(() => {
    reconcileSelection(configuredProviders);
  }, [configuredProviders, reconcileSelection]);

  const currentModel = getSelectedModel();

  const handleProviderChange = useCallback(
    (value: string) => {
      if (!isSupportedProvider(value)) return;
      setProvider(value);
    },
    [setProvider]
  );

  const handleModelChange = useCallback(
    (value: string) => {
      if (!selectedProvider || !isSupportedProvider(selectedProvider)) {
        return;
      }
      setModel(selectedProvider, value);
    },
    [selectedProvider, setModel]
  );

  const handleModelToggle = useCallback(
    (providerId: string, modelId: string, enabled: boolean) => {
      if (!isSupportedProvider(providerId)) return;
      setModelEnabled(providerId, modelId, enabled);
    },
    [setModelEnabled]
  );

  const providerGroups = useMemo<ProviderGroupConfig[]>(() => {
    const runtimeOrder: ProviderRuntime[] = ['hosted', 'gateway', 'local', 'browser'];
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
      const enabledModels = enabledModelsByProvider[providerId] ?? [];
      const modelDefinitions = getProviderModelDefinitions(providerId).filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );

      const models = modelDefinitions.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
        type: 'llm' as const,
        enabled: enabledModels.includes(model.id),
        default: Boolean(model.default),
        supportsStreaming: Boolean(model.supportsStreaming),
      }));

      const group = groups.get(runtime);
      if (!group) continue;

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
  }, [configuredProviders, enabledModelsByProvider]);

  const isProviderReady = Boolean(
    selectedProvider && currentModel && configuredProviders.includes(selectedProvider)
  );

  const disabledReason = useMemo(() => {
    if (configuredProviders.length === 0) {
      return 'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.';
    }
    if (!selectedProvider) {
      return 'Select an AI provider to start chatting.';
    }
    if (!configuredProviders.includes(selectedProvider)) {
      return 'The selected provider is no longer configured.';
    }
    const enabled = enabledModelsByProvider[selectedProvider] ?? [];
    if (enabled.length === 0) {
      const definition = getProviderDefinition(selectedProvider);
      return `Enable at least one model for ${definition.displayName} to continue.`;
    }
    if (!currentModel) {
      return 'Select a model for the chosen provider to continue.';
    }
    return undefined;
  }, [configuredProviders, selectedProvider, enabledModelsByProvider, currentModel]);

  return (
    <AssistantUiPanel
      providerGroups={providerGroups}
      {...(selectedProvider ? { selectedProvider } : {})}
      {...(currentModel ? { selectedModel: currentModel } : {})}
      onProviderChange={handleProviderChange}
      onModelChange={handleModelChange}
      onModelToggle={handleModelToggle}
      disabled={!isProviderReady}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
};

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
