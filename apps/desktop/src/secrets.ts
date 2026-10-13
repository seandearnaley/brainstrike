import { SecretReadError, type SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { HostLoginCredential } from '@brainstrike/agent-host/protocol';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import {
  createHostCredentials,
  type HostCredentials,
} from '@brainstrike/host-capabilities/credentials';
import { getDesktopBootstrapRuntime } from './desktop-bootstrap-runtime';

export {
  credentialStoredKeyFingerprint,
  SecretReadError,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

export { desktopCredentialStoreSelection } from './desktop-credential-selection';

let desktopCredentials: HostCredentials | undefined;

function getDesktopCredentials(): HostCredentials {
  desktopCredentials ??= createHostCredentials({
    selection: getDesktopBootstrapRuntime().credentialStore,
  });
  return desktopCredentials;
}

/** The host's credential writes Settings forwards to; the host is their only writer. */
export interface DesktopCredentialWriter {
  clear(): Promise<boolean>;
  deleteCredential(account: string): Promise<boolean>;
  setCredential(account: string, credential: HostLoginCredential): Promise<void>;
}

/**
 * Main's read-only view of the profile store (Settings listing, hosted
 * embeddings, tool and MCP keys). Subscription tokens stay with the host's one
 * refresher, so an OAuth entry reads as `credential_type_unsupported`. Writes
 * refuse: Settings changes go through {@link createDesktopSettingsSecrets}.
 */
export function getSecretsService(): SecretsService {
  const service = getDesktopCredentials().secrets();
  const refuseWrite = async (): Promise<never> => {
    throw new Error('Main reads credentials only; the agent host owns every credential write');
  };
  return {
    clearAll: refuseWrite,
    deleteKey: refuseWrite,
    getCredential: async (provider) => {
      const credential = await service.getCredential(provider);
      if (credential?.type === 'oauth') {
        throw new SecretReadError('credential_type_unsupported', provider);
      }
      return credential;
    },
    getKey: (provider) => service.getKey(provider),
    listProviders: () => service.listProviders(),
    saveKey: refuseWrite,
    setCredential: refuseWrite,
  };
}

/** Settings: Main's reads plus writes through the host's private desktop client. */
export function createDesktopSettingsSecrets(writer: DesktopCredentialWriter): SecretsService {
  const reads = getSecretsService();
  const write = async (account: string, credential: ProviderCredential): Promise<boolean> => {
    if (credential.type === 'oauth') {
      throw new Error('Subscription sign-in is stored only by the host sign-in flow');
    }
    await writer.setCredential(account, credential);
    return true;
  };
  return {
    ...reads,
    clearAll: () => writer.clear(),
    deleteKey: (account) => writer.deleteCredential(account),
    saveKey: (account, key) => write(account, { key, type: 'api_key' }),
    setCredential: write,
  };
}
