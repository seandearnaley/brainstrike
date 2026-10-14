import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { useMemo } from 'react';

export type EnabledCatalogModels =
  | { readonly state: 'loading' }
  | { readonly message: string; readonly state: 'error' }
  /** `provider::model` keys, the selection's composite identity. */
  | { readonly keys: ReadonlySet<string>; readonly state: 'ready' };

/** The same committed catalog snapshot used by Settings and host admission. */
export function useEnabledCatalogModels(): EnabledCatalogModels {
  const error = useEnsureModelRegistry();
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const models = useModelRegistryStore((state) => state.models);
  return useMemo<EnabledCatalogModels>(() => {
    if (error) {
      return { message: error, state: 'error' };
    }
    if (!hasLoaded) {
      return { state: 'loading' };
    }
    return {
      keys: new Set(
        models.filter((model) => model.isEnabled).map((model) => `${model.providerId}::${model.id}`)
      ),
      state: 'ready',
    };
  }, [error, hasLoaded, models]);
}
