import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretReadError, type SecretsService } from '@brainstrike/agent-host/credential-contract';
import {
  createHostCredentials,
  type HostCredentialStoreSelection,
  type HostCredentials,
  type LegacySecretMigrationReport,
  type LegacySecretSource,
  migrateLegacySecrets,
} from '@brainstrike/host-capabilities/credentials';
import { app, safeStorage } from 'electron';
import { z } from 'zod';
import { isElectronE2ETestMode } from './electron-e2e-test-mode';

export {
  credentialStoredKeyFingerprint,
  credentialToApiKey,
  parseCredentialOrThrow,
  SecretReadError,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

/**
 * The profile's credential store, shared by Main and the forked agent host.
 * Production uses the OS keyring under a profile-scoped service; isolated test
 * runs use a private file inside their disposable profile and never reach the
 * OS keychain.
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
let legacyMigration: Promise<LegacySecretMigrationReport> | undefined;

function getDesktopCredentials(): HostCredentials {
  desktopCredentials ??= createHostCredentials({ selection: desktopCredentialStoreSelection() });
  return desktopCredentials;
}

/**
 * The one-time move of the retired safeStorage entries into the profile's
 * store, started once. Every credential operation in Main and the forked host
 * waits for it; a conflict or decrypt failure keeps the legacy copy and every
 * credential operation rejects with that failure.
 */
export function migrateDesktopLegacySecrets(): Promise<LegacySecretMigrationReport> {
  legacyMigration ??= migrateLegacySecrets({
    destination: getDesktopCredentials().store(),
    source: createSafeStorageLegacySecretSource(),
  });
  return legacyMigration;
}

/** One Main-process authority over the selected store (Settings, OAuth engine, MCP bearer). */
export function getSecretsService(): SecretsService {
  const service = getDesktopCredentials().secrets();
  const migrated = async <T>(operation: () => Promise<T>): Promise<T> => {
    await migrateDesktopLegacySecrets();
    return operation();
  };
  return {
    clearAll: () => migrated(() => service.clearAll()),
    deleteKey: (provider) => migrated(() => service.deleteKey(provider)),
    getCredential: (provider) => migrated(() => service.getCredential(provider)),
    getKey: (provider) => migrated(() => service.getKey(provider)),
    listProviders: () => migrated(() => service.listProviders()),
    saveKey: (provider, value) => migrated(() => service.saveKey(provider, value)),
    setCredential: (provider, credential) =>
      migrated(() => service.setCredential(provider, credential)),
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

/**
 * The retired safeStorage store (`brainstrike-secrets.json`), read only by the
 * one-time migration. Account names and plaintext values are kept as stored;
 * an undecryptable entry fails the whole read and is never skipped. Retiring
 * empties its `secrets` and keeps every other key.
 */
export function createSafeStorageLegacySecretSource(
  file: string = join(app.getPath('userData'), 'brainstrike-secrets.json'),
  storage?: LegacySafeStorage
): LegacySecretSource {
  const read = async (): Promise<z.output<typeof LegacySecretsFileSchema> | undefined> => {
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
  };
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
