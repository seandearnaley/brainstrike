import {
  getProviderDefaultModel,
  getProviderDisplayName,
  getProviderModels,
  PROVIDER_MODELS,
  type SupportedProvider,
} from '@brainstrike/agent/client';
import { AssistantUiPanel } from '@brainstrike/ui/assistant-ui-panel';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useAssistantPreferencesStore } from './stores/assistant-preferences-store';

export interface AssistantUiPanelWrapperProps {
  className?: string;
}

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = () => {
  const [availableProviders, setAvailableProviders] = useState<SupportedProvider[]>([]);

  const {
    selectedProvider,
    modelsByProvider,
    setProvider,
    clearProvider,
    setModel,
    getSelectedModel,
    getAvailableProviders,
  } = useAssistantPreferencesStore();

  // Load available providers on mount
  useEffect(() => {
    const loadProviders = async () => {
      const providers = await getAvailableProviders();
      setAvailableProviders(providers);
      if (selectedProvider && !providers.includes(selectedProvider)) {
        clearProvider();
      }
    };
    void loadProviders();
  }, [getAvailableProviders, selectedProvider, clearProvider]);

  const currentModel = getSelectedModel();

  const handleProviderChange = useCallback(
    (value: string) => {
      const provider = value as SupportedProvider;
      setProvider(provider);
      // Auto-select default model for new provider if current model not available
      const models = getProviderModels(provider);
      const currentModelForProvider = modelsByProvider[provider];
      if (!currentModelForProvider || !models.includes(currentModelForProvider)) {
        const defaultModel = getProviderDefaultModel(provider);
        if (defaultModel) {
          setModel(provider, defaultModel);
        }
      }
    },
    [setProvider, setModel, modelsByProvider]
  );

  const handleModelChange = useCallback(
    (value: string) => {
      if (selectedProvider) {
        setModel(selectedProvider, value);
      }
    },
    [selectedProvider, setModel]
  );

  const providers = useMemo(
    () =>
      availableProviders.map((id) => ({
        id,
        name: getProviderDisplayName(id),
        models: getProviderModels(id),
        defaultModel: (getProviderDefaultModel(id) ?? PROVIDER_MODELS[id]?.[0]) as string,
      })),
    [availableProviders]
  );

  const isProviderReady = Boolean(
    selectedProvider && currentModel && availableProviders.includes(selectedProvider)
  );

  const disabledReason = useMemo(() => {
    if (availableProviders.length === 0) {
      return 'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.';
    }
    if (!selectedProvider) {
      return 'Select an AI provider to start chatting.';
    }
    if (!currentModel) {
      return 'Select a model for the chosen provider to continue.';
    }
    return undefined;
  }, [availableProviders.length, selectedProvider, currentModel]);

  return (
    <AssistantUiPanel
      providers={providers}
      {...(selectedProvider ? { selectedProvider } : {})}
      {...(currentModel ? { selectedModel: currentModel } : {})}
      onProviderChange={handleProviderChange}
      onModelChange={handleModelChange}
      disabled={!isProviderReady}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
};

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
