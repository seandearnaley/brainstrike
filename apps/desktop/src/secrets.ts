import type { SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import {
  createHostCredentials,
  type HostCredentials,
} from '@brainstrike/host-capabilities/credentials';
import { getDesktopBootstrapRuntime } from './desktop-bootstrap-runtime';
import { createSafeStorageCredentialCipher } from './safe-storage-credential-cipher';

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
    cipher: createSafeStorageCredentialCipher(),
    selection: getDesktopBootstrapRuntime().credentialStore,
  });
  return desktopCredentials;
}

/** The host's credential writes Settings forwards to; the host is their only writer. */
export interface DesktopCredentialWriter {
  deleteCredential(account: string): Promise<boolean>;
  setCredential(account: string, credential: ProviderCredential): Promise<void>;
}

/**
 * Main's read-only view of the profile store (Settings listing, hosted
 * embeddings, tool and MCP keys). Writes refuse: Settings changes go through
 * {@link createDesktopSettingsSecrets}.
 */
export function getSecretsService(): SecretsService {
  const service = getDesktopCredentials().secrets();
  const refuseWrite = async (): Promise<never> => {
    throw new Error('Main reads credentials only; the agent host owns every credential write');
  };
  return {
    deleteKey: refuseWrite,
    getCredential: (provider) => service.getCredential(provider),
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
    await writer.setCredential(account, credential);
    return true;
  };
  return {
    ...reads,
    deleteKey: (account) => writer.deleteCredential(account),
    saveKey: (account, key) => write(account, { key, type: 'api_key' }),
    setCredential: write,
  };
}
