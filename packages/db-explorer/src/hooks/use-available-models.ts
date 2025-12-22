import type { DbModel, DbProvider } from '@brainstrike/preferences';
import { useMemo } from 'react';

type AvailableModel = {
  id: string;
  providerId: string;
  name: string;
  description: string;
  capabilities: DbModel['capabilities'];
  pricePer1MTokensInput?: number;
};

type AvailableProvider = {
  id: string;
  name: string;
  icon: string | null;
};

/**
 * Transforms registered models into available embedding models for UI.
 */
export function useAvailableModels(models: DbModel[]): AvailableModel[] {
  return useMemo(
    () =>
      models
        .filter((m) => m.isEnabled && m.capabilities.type === 'embedding')
        .map((m) => ({
          id: m.providerId === 'local' ? m.id : `${m.providerId}::${m.id}`,
          providerId: m.providerId,
          name: m.name,
          description: m.description ?? '',
          capabilities: m.capabilities,
          ...(m.parameters && 'pricePer1MTokens' in m.parameters
            ? {
                pricePer1MTokensInput: (m.parameters as { pricePer1MTokens: number })
                  .pricePer1MTokens,
              }
            : {}),
        })),
    [models]
  );
}

/**
 * Transforms registered providers into available providers for UI.
 */
export function useAvailableProviders(providers: DbProvider[]): AvailableProvider[] {
  return useMemo(
    () =>
      providers
        .filter((p) => p.isEnabled)
        .map((p) => ({
          id: p.id,
          name: p.name,
          icon: p.icon,
        })),
    [providers]
  );
}

export type { AvailableModel, AvailableProvider };
