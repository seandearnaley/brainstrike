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
          id: m.id,
          providerId: m.providerId,
          name: m.name,
          description: m.description,
          capabilities: m.capabilities,
        })),
    [models]
  );

  const availableProviders = useMemo(() => providers.filter((p) => p.isEnabled), [providers]);

  return <PromptManager availableModels={availableModels} providers={availableProviders} />;
}
