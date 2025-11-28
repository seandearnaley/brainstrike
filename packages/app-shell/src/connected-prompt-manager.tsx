import { usePGliteDatabase } from '@brainstrike/db';
import { useModelRegistryStore } from '@brainstrike/preferences';
import { PromptManager } from '@brainstrike/ui';
import { useEffect, useMemo } from 'react';

export function ConnectedPromptManager() {
  const db = usePGliteDatabase();
  const { models, providers, fetchRegistry } = useModelRegistryStore();

  useEffect(() => {
    if (db) {
      void fetchRegistry(db);
    }
  }, [db, fetchRegistry]);

  const availableModels = useMemo(() => {
    return models
      .filter((m) => m.isEnabled)
      .map((m) => ({
        id: m.id,
        providerId: m.providerId,
        name: m.name,
        description: m.description,
        capabilities: m.capabilities,
      }));
  }, [models]);

  const availableProviders = useMemo(() => {
    return providers.filter((p) => p.isEnabled);
  }, [providers]);

  return <PromptManager availableModels={availableModels} providers={availableProviders} />;
}
