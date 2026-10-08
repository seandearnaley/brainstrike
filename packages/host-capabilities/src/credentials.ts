import { resolve } from 'node:path';
import type { HostPlatformLaunchOptions } from '@brainstrike/agent-host';
import type {
  KeyringCredentialBackend,
  KeyringCredentialStore,
  SecretsService,
} from '@brainstrike/agent-host/credential-contract';
import {
  createFileCredentialBackend,
  isMcpOAuthCredentialAccount,
} from '@brainstrike/agent-host/file-credentials';
import {
  createKeyringCredentialStore,
  createKeyringSecretsService,
} from '@brainstrike/agent-host/keyring-credentials';
import { createKeyringCredentialBackend } from '@brainstrike/agent-host/keyring-native';

export type HostCredentialStoreSelection = NonNullable<
  HostPlatformLaunchOptions['credentialStore']
>;

export class HostCredentialsClosedError extends Error {
  readonly code = 'host_credentials_closed';
  constructor() {
    super('The host credential authority is closing.');
    this.name = 'HostCredentialsClosedError';
  }
}

export class HostCredentialStoreUnselectedError extends Error {
  readonly code = 'host_credential_store_unselected';
  constructor() {
    super(
      'Credential reads require an explicitly selected credential service; file fallback is not automatic'
    );
    this.name = 'HostCredentialStoreUnselectedError';
  }
}

/**
 * The one credential authority of a host process. Provider keys, MCP bearer
 * keys and MCP OAuth records share this store under their existing account
 * names; the Settings namespace excludes only the OAuth record hashes.
 */
export interface HostCredentials {
  close(): Promise<void>;
  /** Settings/provider namespace: everything except MCP OAuth record accounts. */
  secrets(): SecretsService;
  /** Raw account store shared with the MCP OAuth record owner. */
  store(): KeyringCredentialStore;
}

export interface HostCredentialsOptions {
  /** Trusted composition seam for fixtures; production uses the native worker. */
  readonly createNativeBackend?: (service: string) => KeyringCredentialBackend;
  /** Explicit launch selection; absent means no credential authority exists. */
  readonly selection: HostCredentialStoreSelection | undefined;
}

/** Lazy: no native worker or file access happens before the first credential read. */
export function createHostCredentials(options: HostCredentialsOptions): HostCredentials {
  let store: KeyringCredentialStore | undefined;
  let secrets: SecretsService | undefined;
  let closing: Promise<void> | undefined;
  const open = (): KeyringCredentialStore => {
    if (closing) {
      throw new HostCredentialsClosedError();
    }
    const selection = options.selection;
    if (!selection) {
      throw new HostCredentialStoreUnselectedError();
    }
    if (!store) {
      const service = selection.kind === 'file' ? resolve(selection.path) : selection.service;
      store = createKeyringCredentialStore({
        backend:
          selection.kind === 'file'
            ? createFileCredentialBackend(service)
            : (options.createNativeBackend ?? createKeyringCredentialBackend)(service),
        service,
      });
    }
    return store;
  };
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        await store?.close();
      });
      return closing;
    },
    secrets: () => {
      const credentials = open();
      secrets ??= createKeyringSecretsService({
        accountForProvider: (provider) => provider,
        credentials,
        providerForAccount: (account) =>
          isMcpOAuthCredentialAccount(account) ? undefined : account,
      });
      return secrets;
    },
    store: open,
  };
}

export {
  LegacySecretConflictError,
  type LegacySecretEntry,
  type LegacySecretMigrationReport,
  type LegacySecretSource,
  LegacySecretVerificationError,
  migrateLegacySecrets,
} from './legacy-secret-migration.js';
