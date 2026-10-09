import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { usePGliteDatabase } from '@brainstrike/db/react';
import { useAssistantProviderSource } from './hooks/assistant-provider-source';
import { useConfiguredAssistantProviders } from './hooks/use-configured-assistant-providers';
import { useProviderModelDefaults } from './hooks/use-provider-model-defaults';

/**
 * The one owner of first-configuration model defaults (BST-1794). It sits
 * beside the thread workspace, not inside a thread panel, so legacy and host
 * threads alike get a newly configured provider's catalog policy, applied once
 * per credential revision.
 */
export function AssistantProviderModelDefaults({
  providerReadErrors,
}: {
  readonly providerReadErrors?: Partial<Record<SupportedProvider, string>>;
}): null {
  const source = useAssistantProviderSource();
  const { providers } = useConfiguredAssistantProviders();
  const database = usePGliteDatabase();
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);
  // The policy waits for the registry, which no thread panel may have loaded yet.
  useEnsureModelRegistry();
  useProviderModelDefaults(
    providers,
    database,
    secretsVersion,
    source.kind === 'discovery',
    providerReadErrors
  );
  return null;
}
