import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { PromptManager } from '@brainstrike/ui';
import { useMemo } from 'react';

export function ConnectedPromptManager() {
  useEnsureModelRegistry();
  const { models, providers } = useModelRegistryStore();

  const availableModels = useMemo(
    () =>
      models
        .filter((m) => m.isEnabled)
        .map((m) => ({
          capabilities: m.capabilities,
          description: m.description,
          id: m.id,
          name: m.name,
          providerId: m.providerId,
        })),
    [models]
  );

  const availableProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers]);

  return <PromptManager availableModels={availableModels} providers={availableProviders} />;
}
