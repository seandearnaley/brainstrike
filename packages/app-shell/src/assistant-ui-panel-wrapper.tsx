import {
  getProviderDefaultModel,
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
  initialProviders?: SupportedProvider[];
}

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = ({ initialProviders }) => {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(
    () => initialProviders ?? []
  );

  const {
    enabledModelsByProvider,
    setModel,
    clearModel,
    setModelEnabled,
    getAvailableProviders,
    getSelectedModel,
    getSelectedProvider,
  } = useAssistantPreferencesStore();

  const selectedProvider = getSelectedProvider();

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => (enabledModelsByProvider[provider] ?? []).length > 0,
    [enabledModelsByProvider]
  );

  const selectModelForProvider = useCallback(
    (provider: SupportedProvider) => {
      const enabledModels = enabledModelsByProvider[provider] ?? [];
      if (enabledModels.length === 0) return;

      const defaultModel = getProviderDefaultModel(provider);
      const modelToSelect =
        defaultModel && enabledModels.includes(defaultModel) ? defaultModel : enabledModels[0];
      setModel(`${provider}::${modelToSelect}`);
    },
    [enabledModelsByProvider, setModel]
  );

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      if (initialProviders !== undefined) {
        setConfiguredProviders(initialProviders);
        return;
      }

      const providers = await getAvailableProviders();
      if (cancelled) return;
      setConfiguredProviders(providers);
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
  }, [initialProviders, getAvailableProviders]);

  // Reconcile selection whenever providers or enabled models change
  // Using useEffect (not useLayoutEffect) because we're mutating external state (Zustand store)
  // React will properly batch these updates and handle them in the commit phase
  useEffect(() => {
    if (configuredProviders.length === 0) {
      return;
    }

    const currentProvider = getSelectedProvider();

    // Case 1: Current provider is no longer available
    if (currentProvider && !configuredProviders.includes(currentProvider)) {
      clearModel();
      return;
    }

    // Case 2: Current provider exists and has enabled models - nothing to do
    if (currentProvider && providerHasEnabledModels(currentProvider)) {
      return;
    }

    // Case 3: Find the first provider with enabled models
    const next = configuredProviders.find((providerId) => providerHasEnabledModels(providerId));
    if (next) {
      selectModelForProvider(next);
      return;
    }

    // Case 4: No providers with enabled models, clear selection
    if (currentProvider) {
      clearModel();
    }
  }, [
    configuredProviders,
    enabledModelsByProvider,
    getSelectedProvider,
    clearModel,
    providerHasEnabledModels,
    selectModelForProvider,
  ]);

  const currentModel = getSelectedModel();

  const handleModelChange = useCallback(
    (compositeKey: string) => {
      // Composite key format: "provider::model"
      setModel(compositeKey);
    },
    [setModel]
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
      onModelChange={handleModelChange}
      onModelToggle={handleModelToggle}
      disabled={!isProviderReady}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
};

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
