import type { DeprecatedEnvVarReport, ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui';
import { CredentialInventory } from './credential-inventory/credential-inventory';

export interface ApiKeysSettingsProps {
  /** Deprecated env names found set, from the assistant status probe (BST-1361). */
  readonly statusDeprecatedEnvVars?: readonly DeprecatedEnvVarReport[] | undefined;
  readonly statusError?: string | undefined;
  readonly statusProviderKeySources?: readonly ProviderKeySource<SupportedProvider>[] | undefined;
}

/**
 * Settings section for managing LLM provider API keys and the Tavily
 * web-search key: the all-keys Credential Inventory table (BST-1362).
 * Uses the Electron `window.secrets` API for secure storage.
 *
 * @platform desktop
 */
export function ApiKeysSettings({
  statusDeprecatedEnvVars,
  statusError,
  statusProviderKeySources,
}: ApiKeysSettingsProps = {}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Credential Inventory</CardTitle>
        <p className="text-muted-foreground text-xs">
          One row per credential. Environment variables always win over keys stored here; the
          Variable column is the exact name to use in .env files or CI.
        </p>
      </CardHeader>
      <CardContent>
        <CredentialInventory
          deprecatedEnvVars={statusDeprecatedEnvVars}
          statusError={statusError}
          statusProviderKeySources={statusProviderKeySources}
        />
      </CardContent>
    </Card>
  );
}

export default ApiKeysSettings;
