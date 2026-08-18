import {
  describeSecretReadError,
  isProviderCredential,
  isStoredKeyFingerprint,
  MalformedCredentialError,
  type ProviderCredential,
  parseStoredCredential,
  type SecretReadErrorCode,
  type StoredKeyFingerprint,
} from '@brainstrike/assistant-contract';
import { safeStorage } from 'electron';
import ElectronStore from 'electron-store';

export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

/**
 * A stored secret exists but cannot be read. Distinct from the `null` "not
 * set" result on purpose (NO SILENT FALLBACKS): a corrupt entry or an unusable
 * safeStorage backend (e.g. after a keychain migration) previously read as
 * "no key", presenting to the user as if they had deleted their API keys.
 * Message text comes from the SHARED assistant-contract builder so every
 * SecretReadError-shaped producer stays byte-identical (BST-1352 review).
 */
export class SecretReadError extends Error {
  readonly code: SecretReadErrorCode;
  readonly provider: string;

  constructor(code: SecretReadErrorCode, provider: string, cause?: unknown) {
    super(describeSecretReadError(code, provider), { cause });
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
   * credential THROWS `SecretReadError('credential_type_unsupported', …)` so
   * string-only consumers (inspectProviderKeys, the assistant HTTP path)
   * degrade to their existing per-provider read-failure handling — the
   * credential is never stringified.
   */
  getKey: (provider: string) => Promise<string | null>;
  listProviders: () => Promise<string[]>;
  /**
   * Delegates to `setCredential({ type: 'api_key', key: value })` — a single
   * write path that always stores the JSON envelope. Legacy bare-string reads
   * remain supported forever via parseStoredCredential.
   */
  saveKey: (provider: string, value: string) => Promise<boolean>;
  /** Typed write (BST-1348): stores `JSON.stringify(credential)` encrypted. */
  setCredential: (provider: string, credential: ProviderCredential) => Promise<boolean>;
}

/**
 * Interpret a decrypted stored value as a typed credential, surfacing a
 * tagged-but-invalid value as `SecretReadError('malformed_credential', …)`.
 * The ONE credential-interpretation site — the production service and the
 * test-mode Secrets IPC path both go through here (no duplicated mapping).
 */
export function parseCredentialOrThrow(provider: string, raw: string): ProviderCredential {
  try {
    return parseStoredCredential(raw);
  } catch (error) {
    if (error instanceof MalformedCredentialError) {
      throw new SecretReadError('malformed_credential', provider, error);
    }
    throw error;
  }
}

/**
 * Project a typed credential onto the string-key API. Only `api_key`
 * credentials have a string projection; anything else throws
 * `SecretReadError('credential_type_unsupported', …)` — a structured
 * credential is never stringified. Shared by the production `getKey` and the
 * test-mode Secrets IPC `secrets:get` path.
 */
export function credentialToApiKey(provider: string, credential: ProviderCredential): string {
  if (credential.type !== 'api_key') {
    throw new SecretReadError('credential_type_unsupported', provider);
  }
  return credential.key;
}

/**
 * Project the save-time `{last4, savedAt}` fingerprint (BST-1362) out of a
 * stored credential's metadata for the `secrets:list` payload. Only these two
 * keys ever cross the wire — other metadata stays main-side. A fingerprint
 * exists only when BOTH keys are present (the single save path always writes
 * them together); a partial pair is hand-tampered provenance and is withheld
 * rather than forwarded or guessed at. `oauth` has no metadata field.
 *
 * Shape validation is the SHARED `isStoredKeyFingerprint` guard — the exact
 * rules the renderer's `parseProviderKeySources` enforces (`last4` a 1-4
 * character string, `savedAt` parseable) — so main can never forward a shape
 * the renderer would hard-fail the whole listing on. An out-of-shape pair is
 * hand-tampered provenance: the fingerprint is dropped (nothing but the
 * non-secret hint is lost) while the entry itself stays listed as stored.
 */
export function credentialStoredKeyFingerprint(
  credential: ProviderCredential
): StoredKeyFingerprint | undefined {
  if (credential.type === 'oauth') {
    return;
  }
  const metadata = credential.metadata;
  if (!metadata) {
    return;
  }
  const candidate = { last4: metadata['last4'], savedAt: metadata['savedAt'] };
  return isStoredKeyFingerprint(candidate) ? candidate : undefined;
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
