import {
  credentialToApiKey,
  parseCredentialOrThrow,
  SecretReadError,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
import {
  isProviderCredential,
  MalformedCredentialError,
  type ProviderCredential,
} from '@brainstrike/assistant-contract';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export {
  credentialStoredKeyFingerprint,
  credentialToApiKey,
  parseCredentialOrThrow,
  SecretReadError,
  type SecretsService,
} from '@brainstrike/agent-host/credential-contract';
export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

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

  /**
   * Decrypts the stored value for a provider and interprets it as a typed
   * credential. Returns null strictly for "not set"; every failure throws a
   * typed SecretReadError (NO SILENT FALLBACKS).
   */
  function readStoredCredential(provider: string): ProviderCredential | null {
    const b64 = (secretsStore.get('secrets') as SecretsSchema['secrets'])?.[provider];
    if (!b64) {
      // Strictly "not set" — failures below throw instead of masquerading
      // as this case (see SecretReadError).
      return null;
    }
    if (!hasUsableSafeStorageEncryption()) {
      throw new SecretReadError('encryption_unavailable', provider);
    }
    let raw: string;
    try {
      raw = safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch (error) {
      throw new SecretReadError('decrypt_failed', provider, error);
    }
    return parseCredentialOrThrow(provider, raw);
  }

  function writeEncrypted(provider: string, plaintext: string): boolean {
    if (!hasUsableSafeStorageEncryption()) {
      throw new Error('encryption_unavailable');
    }
    const b64 = Buffer.from(safeStorage.encryptString(plaintext)).toString('base64');
    const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
    secrets[provider] = b64;
    secretsStore.set('secrets', secrets);
    return true;
  }

  function writeCredential(provider: string, credential: ProviderCredential): boolean {
    if (!isProviderCredential(credential)) {
      // IPC payloads reach here as unknown at runtime — reject malformed
      // input (including an empty api_key) before it is ever persisted
      // (NO SILENT FALLBACKS).
      throw new MalformedCredentialError(
        'setCredential received an invalid or unrecognized credential object'
      );
    }
    return writeEncrypted(provider, JSON.stringify(credential));
  }

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
    async getCredential(provider: string): Promise<ProviderCredential | null> {
      return readStoredCredential(provider);
    },
    async getKey(provider: string): Promise<string | null> {
      const credential = readStoredCredential(provider);
      if (credential === null) {
        return null;
      }
      return credentialToApiKey(provider, credential);
    },
    async listProviders(): Promise<string[]> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      return Object.keys(secrets);
    },
    async saveKey(provider: string, value: string): Promise<boolean> {
      // Single write path: every save stores the typed JSON envelope. Legacy
      // bare-string READS remain supported forever via parseStoredCredential.
      return writeCredential(provider, { key: value, type: 'api_key' });
    },
    async setCredential(provider: string, credential: ProviderCredential): Promise<boolean> {
      return writeCredential(provider, credential);
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
