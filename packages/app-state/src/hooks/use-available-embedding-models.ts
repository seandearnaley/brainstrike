import { formatProviderModelKey } from '@brainstrike/utils';
import { useMemo } from 'react';
import type { DbModel, DbProvider } from '../stores/model-registry-store.ts';

interface AvailableModel {
  // Picker-dialect capabilities: the DB catalog stores `vision` as a boolean
  // jsonb flag while ModelPickerModel expects 'supported' | 'unsupported';
  // translated in useAvailableModels (moot for the embedding-only rows this
  // hook surfaces, but keeps the shapes honest instead of casting).
  capabilities: Omit<DbModel['capabilities'], 'vision'> & {
    vision?: 'supported' | 'unsupported';
  };
  description: string;
  id: string;
  modelId: string;
  name: string;
  pricePer1MTokensInput?: number;
  providerId: string;
}

interface AvailableProvider {
  icon: string | null;
  id: string;
  name: string;
}

function toPickerCapabilities(
  capabilities: DbModel['capabilities']
): AvailableModel['capabilities'] {
  const { vision, ...rest } = capabilities;
  return {
    ...rest,
    ...(vision === undefined
      ? {}
      : { vision: vision ? ('supported' as const) : ('unsupported' as const) }),
  };
}

/**
 * Transforms registered models into available embedding models for UI.
 */
export function useAvailableModels(models: DbModel[]): AvailableModel[] {
  return useMemo(
    () =>
      models
        .filter((m) => m.isEnabled && m.capabilities.type === 'embedding')
        .map((m) => ({
          capabilities: toPickerCapabilities(m.capabilities),
          description: m.description ?? '',
          id: formatProviderModelKey(m.providerId, m.id),
          modelId: m.id,
          name: m.name,
          providerId: m.providerId,
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
          icon: p.icon,
          id: p.id,
          name: p.name,
        })),
    [providers]
  );
}

export type { AvailableModel, AvailableProvider };
