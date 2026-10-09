import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretReadError, type SecretsService } from '@brainstrike/agent-host/credential-contract';
import type { HostLegacyImport, HostLoginCredential } from '@brainstrike/agent-host/protocol';
import type { ProviderCredential } from '@brainstrike/assistant-contract';
import {
  createHostCredentials,
  type HostCredentialStoreSelection,
  type HostCredentials,
  type LegacySecretMigrationReport,
  type LegacySecretSource,
} from '@brainstrike/host-capabilities/credentials';
import { app, safeStorage } from 'electron';
import { z } from 'zod';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

export {
  credentialStoredKeyFingerprint,
  SecretReadError,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

/**
 * The profile's credential store: the forked agent host is its writer and Main
 * reads it. Production uses the OS keyring under a profile-scoped service;
 * isolated test runs use a private file inside their disposable profile and
 * never reach the OS keychain.
 */
export function desktopCredentialStoreSelection(
  userData: string = app.getPath('userData'),
  // Same isolation predicate as the Settings secrets IPC test mode.
  isolated: boolean = isElectronE2ETestMode() || process.env['NODE_ENV'] === 'test'
): HostCredentialStoreSelection {
  return isolated
    ? { kind: 'file', path: join(userData, 'brainstrike-credentials.json') }
    : { kind: 'keyring', service: `brainstrike-desktop:${userData}` };
}

let desktopCredentials: HostCredentials | undefined;

function getDesktopCredentials(): HostCredentials {
  desktopCredentials ??= createHostCredentials({ selection: desktopCredentialStoreSelection() });
  return desktopCredentials;
}

/** Hands the decrypted retired store to the host this app launched (`auth/import-legacy`). */
export type DesktopLegacyImporter = (
  input: HostLegacyImport
) => Promise<LegacySecretMigrationReport>;

let legacyImporter: DesktopLegacyImporter | undefined;
let legacyImport:
  | { readonly promise: Promise<LegacySecretMigrationReport>; settled: boolean }
  | undefined;

/** Desktop composition installs the host import once, before the first credential use. */
export function installDesktopLegacyImporter(importer: DesktopLegacyImporter): void {
  legacyImporter = importer;
}

/** Whether the retired store still holds entries; read without decrypting. */
export async function desktopLegacySecretsPending(
  file: string = defaultLegacySecretsFile()
): Promise<boolean> {
  return Object.keys((await readLegacySecretsFile(file))?.secrets ?? {}).length > 0;
}

async function runDesktopLegacyImport(): Promise<LegacySecretMigrationReport> {
  const source = createSafeStorageLegacySecretSource();
  let entries: Awaited<ReturnType<LegacySecretSource['entries']>>;
  try {
    entries = await source.entries();
  } catch (cause) {
    // The host holds credential use until it hears; an unreadable store is its answer too.
    await legacyImporter?.({
      unavailable: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => undefined);
    throw cause;
  }
  if (entries.length === 0) {
    return { alreadyPresent: 0, migrated: 0 };
  }
  if (!legacyImporter) {
    throw new Error('The retired credential store can only be imported through the agent host');
  }
  const report = await legacyImporter({
    entries: entries.map(({ account, value }) => ({ account, value })),
  });
  // Retired only after the host verified every entry, which also records completion.
  await source.retire();
  return report;
}

/**
 * The one-time move of the retired safeStorage entries into the profile store.
 * Only Main can decrypt them; the host, their only writer, imports them once
 * it is ready. Main's credential reads join this import. A host launched
 * while entries remained holds its own credential use until it hears, so a
 * relaunched host (`afterHostLaunch`) is told again after a failed import.
 */
export function importDesktopLegacySecrets(
  options: { readonly afterHostLaunch?: boolean } = {}
): Promise<LegacySecretMigrationReport> {
  if (legacyImport && !(options.afterHostLaunch && legacyImport.settled)) {
    return legacyImport.promise;
  }
  const current = { promise: runDesktopLegacyImport(), settled: false };
  const settle = (): void => {
    current.settled = true;
  };
  current.promise.then(settle, settle);
  legacyImport = current;
  return current.promise;
}

/** The host's credential writes Settings forwards to; the host is their only writer. */
export interface DesktopCredentialWriter {
  clear(): Promise<boolean>;
  deleteCredential(account: string): Promise<boolean>;
  setCredential(account: string, credential: HostLoginCredential): Promise<void>;
}

function awaitingMigration<T>(operation: () => Promise<T>): Promise<T> {
  return importDesktopLegacySecrets().then(operation);
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
    getCredential: (provider) =>
      awaitingMigration(async () => {
        const credential = await service.getCredential(provider);
        if (credential?.type === 'oauth') {
          throw new SecretReadError('credential_type_unsupported', provider);
        }
        return credential;
      }),
    getKey: (provider) => awaitingMigration(() => service.getKey(provider)),
    listProviders: () => awaitingMigration(() => service.listProviders()),
    saveKey: refuseWrite,
    setCredential: refuseWrite,
  };
}

/** Settings: Main's reads plus writes through the host's private desktop client. */
export function createDesktopSettingsSecrets(writer: DesktopCredentialWriter): SecretsService {
  const reads = getSecretsService();
  const write = (account: string, credential: ProviderCredential): Promise<boolean> =>
    awaitingMigration(async () => {
      if (credential.type === 'oauth') {
        throw new Error('Subscription sign-in is stored only by the host sign-in flow');
      }
      await writer.setCredential(account, credential);
      return true;
    });
  return {
    ...reads,
    clearAll: () => awaitingMigration(() => writer.clear()),
    deleteKey: (account) => awaitingMigration(() => writer.deleteCredential(account)),
    saveKey: (account, key) => write(account, { key, type: 'api_key' }),
    setCredential: write,
  };
}

export interface LegacySafeStorage {
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
  isEncryptionAvailable(): boolean;
}

/** electron-store's plain JSON file; only `secrets` (base64 ciphertext) is read. */
const LegacySecretsFileSchema = z.looseObject({
  secrets: z.record(z.string(), z.string()).optional(),
});

function defaultLegacySecretsFile(): string {
  return join(app.getPath('userData'), 'brainstrike-secrets.json');
}

async function readLegacySecretsFile(
  file: string
): Promise<z.output<typeof LegacySecretsFileSchema> | undefined> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  return LegacySecretsFileSchema.parse(JSON.parse(content));
}

/**
 * The retired safeStorage store (`brainstrike-secrets.json`), read only by the
 * one-time migration. Account names and plaintext values are kept as stored;
 * an undecryptable entry fails the whole read and is never skipped. Retiring
 * empties its `secrets` and keeps every other key.
 */
export function createSafeStorageLegacySecretSource(
  file: string = defaultLegacySecretsFile(),
  storage?: LegacySafeStorage
): LegacySecretSource {
  const read = (): Promise<z.output<typeof LegacySecretsFileSchema> | undefined> =>
    readLegacySecretsFile(file);
  return {
    entries: async () => {
      const encrypted = Object.entries((await read())?.secrets ?? {});
      if (encrypted.length === 0) {
        return [];
      }
      // Decryption is the only Electron dependency, needed only when entries exist.
      const decryptor = storage ?? safeStorage;
      const usable =
        decryptor.isEncryptionAvailable() &&
        decryptor.getSelectedStorageBackend?.() !== 'basic_text';
      return encrypted.map(([account, value]) => {
        if (!usable) {
          throw new SecretReadError('encryption_unavailable', account);
        }
        try {
          return { account, value: decryptor.decryptString(Buffer.from(value, 'base64')) };
        } catch (error) {
          throw new SecretReadError('decrypt_failed', account, error);
        }
      });
    },
    retire: async () => {
      const current = await read();
      if (current) {
        // Same-directory rename keeps the retirement atomic.
        const next = `${file}.retired-${process.pid}`;
        await writeFile(next, JSON.stringify({ ...current, secrets: {} }, null, '\t'), {
          mode: 0o600,
        });
        await rename(next, file);
      }
    },
  };
}
