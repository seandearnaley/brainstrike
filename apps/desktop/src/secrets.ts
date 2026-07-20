import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export type SecretReadErrorCode = 'decrypt_failed' | 'encryption_unavailable';

/**
 * A stored secret exists but cannot be read. Distinct from the `null` "not
 * set" result on purpose (NO SILENT FALLBACKS): a corrupt entry or an unusable
 * safeStorage backend (e.g. after a keychain migration) previously read as
 * "no key", presenting to the user as if they had deleted their API keys.
 */
export class SecretReadError extends Error {
  readonly code: SecretReadErrorCode;
  readonly provider: string;

  constructor(code: SecretReadErrorCode, provider: string, cause?: unknown) {
    const detail =
      code === 'decrypt_failed'
        ? 'stored secret could not be decrypted (the OS keychain entry may have changed)'
        : 'safeStorage encryption is unavailable or insecure on this system';
    super(`Secret for "${provider}" is unreadable: ${detail}. Re-enter the key to repair it.`, {
      cause,
    });
    this.name = 'SecretReadError';
    this.code = code;
    this.provider = provider;
  }
}

export interface SecretsService {
  clearAll: () => Promise<boolean>;
  deleteKey: (provider: string) => Promise<boolean>;
  getKey: (provider: string) => Promise<string | null>;
  listProviders: () => Promise<string[]>;
  saveKey: (provider: string, value: string) => Promise<boolean>;
}

interface SecretsSchema {
  secrets: Record<string, string>; // base64-encoded encrypted strings
}

function hasUsableSafeStorageEncryption(): boolean {
  return (
    Boolean(safeStorage?.isEncryptionAvailable?.()) &&
    safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  );
}

export function createSecretsService(store?: ElectronStore<SecretsSchema>): SecretsService {
  const _store = store ?? new ElectronStore<SecretsSchema>({ name: 'brainstrike-secrets' });
  // Work around ElectronStore Conf typings in TS builds
  const secretsStore = _store as ElectronStore<SecretsSchema> & {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  };

  return {
    async clearAll(): Promise<boolean> {
      try {
        secretsStore.set('secrets', {});
        return true;
      } catch {
        return false;
      }
    },
    async deleteKey(provider: string): Promise<boolean> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      if (!Object.hasOwn(secrets, provider)) {
        return false;
      }
      const next = Object.fromEntries(
        Object.entries(secrets).filter(([key]) => key !== provider)
      ) as SecretsSchema['secrets'];
      secretsStore.set('secrets', next);
      return true;
    },
    async getKey(provider: string): Promise<string | null> {
      const b64 = (secretsStore.get('secrets') as SecretsSchema['secrets'])?.[provider];
      if (!b64) {
        // Strictly "not set" — failures below throw instead of masquerading
        // as this case (see SecretReadError).
        return null;
      }
      if (!hasUsableSafeStorageEncryption()) {
        throw new SecretReadError('encryption_unavailable', provider);
      }
      try {
        return safeStorage.decryptString(Buffer.from(b64, 'base64'));
      } catch (error) {
        throw new SecretReadError('decrypt_failed', provider, error);
      }
    },
    async listProviders(): Promise<string[]> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      return Object.keys(secrets);
    },
    async saveKey(provider: string, value: string): Promise<boolean> {
      if (!hasUsableSafeStorageEncryption()) {
        throw new Error('encryption_unavailable');
      }
      const b64 = Buffer.from(safeStorage.encryptString(value)).toString('base64');
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      secrets[provider] = b64;
      secretsStore.set('secrets', secrets);
      return true;
    },
  } satisfies SecretsService;
}

// Singleton accessor for consumers (e.g., assistant server) without circular DI
let __secretsInstance: SecretsService | null = null;
export function getSecretsService(): SecretsService {
  if (!__secretsInstance) {
    __secretsInstance = createSecretsService();
  }
  return __secretsInstance;
}
