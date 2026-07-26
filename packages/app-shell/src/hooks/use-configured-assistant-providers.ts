import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useEffect, useState } from 'react';

interface UseConfiguredAssistantProvidersOptions {
  readonly getAvailableProviders: () => Promise<SupportedProvider[]>;
  readonly initialProviders?: readonly SupportedProvider[];
  readonly providerSeeds?: readonly SupportedProvider[];
  readonly secretsVersion: number;
}

export function useConfiguredAssistantProviders({
  getAvailableProviders,
  initialProviders,
  providerSeeds,
  secretsVersion,
}: UseConfiguredAssistantProvidersOptions): SupportedProvider[] {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(() => [
    ...(initialProviders ?? providerSeeds ?? []),
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async (): Promise<void> => {
      if (initialProviders !== undefined) {
        setConfiguredProviders([...initialProviders]);
        return;
      }

      const discoveredProviders = await getAvailableProviders();
      if (cancelled) {
        return;
      }
      setConfiguredProviders(mergeProviders(providerSeeds, discoveredProviders));
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
  }, [getAvailableProviders, initialProviders, providerSeeds, secretsVersion]);

  return configuredProviders;
}

function mergeProviders(
  providerSeeds: readonly SupportedProvider[] | undefined,
  discoveredProviders: readonly SupportedProvider[]
): SupportedProvider[] {
  const merged = new Set(providerSeeds);
  for (const provider of discoveredProviders) {
    merged.add(provider);
  }
  return [...merged];
}
