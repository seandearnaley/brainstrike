import { usePGliteDatabase } from '@brainstrike/db';
import { useModelRegistryStore } from '@brainstrike/preferences';
import { PromptManager } from '@brainstrike/ui';
import { useEffect, useMemo } from 'react';

export function ConnectedPromptManager() {
  const db = usePGliteDatabase();
  const { models, fetchRegistry } = useModelRegistryStore();

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
        name: m.name,
        providerId: m.providerId,
      }));
  }, [models]);

  return <PromptManager availableModels={availableModels} />;
}
