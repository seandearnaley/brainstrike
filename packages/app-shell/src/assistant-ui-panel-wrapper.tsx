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

/**
 * Auto-select first provider and its default model
 */
function autoSelectFirstProvider(
  provider: SupportedProvider,
  setProvider: (p: SupportedProvider) => void,
  setModel: (p: SupportedProvider, m: string) => void
): void {
  setProvider(provider);
  const defaultModel = getProviderDefaultModel(provider);
  if (defaultModel) {
    setModel(provider, defaultModel);
  }
}

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = () => {
  const [availableProviders, setAvailableProviders] = useState<SupportedProvider[]>([]);

  const {
    selectedProvider,
    modelsByProvider,
    setProvider,
    clearProvider,
    setModel,
    getAvailableProviders,
  } = useAssistantPreferencesStore();

  // Load available providers on mount
  useEffect(() => {
    const loadProviders = async () => {
      const providers = await getAvailableProviders();
      setAvailableProviders(providers);

      // Clear provider if current selection is no longer available
      if (selectedProvider && !providers.includes(selectedProvider)) {
        clearProvider();
        return;
      }

      // Auto-select first provider if none selected and providers are available
      if (!selectedProvider && providers.length > 0 && providers[0]) {
        autoSelectFirstProvider(providers[0], setProvider, setModel);
      }
    };
    void loadProviders();
  }, [getAvailableProviders, selectedProvider, clearProvider, setProvider, setModel]);

  const currentModel = selectedProvider
    ? (modelsByProvider[selectedProvider] ?? getProviderDefaultModel(selectedProvider))
    : null;

  const handleProviderChange = useCallback(
    (value: string) => {
      const provider = value as SupportedProvider;
      setProvider(provider);

      // Ensure the new provider has a valid model selected
      const models = getProviderModels(provider);
      const currentModelForProvider = modelsByProvider[provider];

      // If no model is set for this provider, or the current model is invalid, set the default
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
