import {
  isProviderCredential,
  MalformedCredentialError,
  type ProviderCredential,
  parseStoredCredential,
  type SecretReadErrorCode,
} from '@brainstrike/assistant-contract';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

const SECRET_READ_ERROR_DETAIL: Record<SecretReadErrorCode, string> = {
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  decrypt_failed: 'stored secret could not be decrypted (the OS keychain entry may have changed)',
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  encryption_unavailable: 'safeStorage encryption is unavailable or insecure on this system',
  // biome-ignore lint/style/useNamingConvention: SecretReadErrorCode wire code.
  malformed_credential:
    'stored credential payload is tagged but unrecognized or invalid (never coerced to an API key)',
};

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
    const detail = SECRET_READ_ERROR_DETAIL[code];
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
  /**
   * Typed read (BST-1348). Legacy bare-string values map to
   * `{ type: 'api_key', key: <raw> }` per the decision table in
   * `@brainstrike/assistant-contract` provider-credential.ts. A stored value
   * that is tagged but unrecognized/invalid throws
   * `SecretReadError('malformed_credential', …)` — never coerced.
   */
  getCredential: (provider: string) => Promise<ProviderCredential | null>;
  /**
   * String read for api_key credentials only. A stored `oauth`/`aws`
   * credential THROWS a plain Error (programming error: the caller must use
   * getCredential) — the credential is never stringified.
   */
  getKey: (provider: string) => Promise<string | null>;
  listProviders: () => Promise<string[]>;
  saveKey: (provider: string, value: string) => Promise<boolean>;
  /** Typed write (BST-1348): stores `JSON.stringify(credential)` encrypted. */
  setCredential: (provider: string, credential: ProviderCredential) => Promise<boolean>;
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
    try {
      return parseStoredCredential(raw);
    } catch (error) {
      if (error instanceof MalformedCredentialError) {
        throw new SecretReadError('malformed_credential', provider, error);
      }
      throw error;
    }
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
      if (credential.type !== 'api_key') {
        // Programming error: the caller must use getCredential for typed
        // variants. Never stringify a structured credential into a "key".
        throw new Error(
          `getKey("${provider}") read a stored "${credential.type}" credential; use getCredential instead.`
        );
      }
      return credential.key;
    },
    async listProviders(): Promise<string[]> {
      const secrets = (secretsStore.get('secrets') as SecretsSchema['secrets']) ?? {};
      return Object.keys(secrets);
    },
    async saveKey(provider: string, value: string): Promise<boolean> {
      // Deliberately still stores the bare string (not a typed api_key JSON):
      // the legacy read mapping covers it, and older builds reading the store
      // keep working during the transition.
      return writeEncrypted(provider, value);
    },
    async setCredential(provider: string, credential: ProviderCredential): Promise<boolean> {
      if (!isProviderCredential(credential)) {
        // IPC payloads reach here as unknown at runtime — reject malformed
        // input before it is ever persisted (NO SILENT FALLBACKS).
        throw new MalformedCredentialError(
          'setCredential received an invalid or unrecognized credential object'
        );
      }
      return writeEncrypted(provider, JSON.stringify(credential));
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
