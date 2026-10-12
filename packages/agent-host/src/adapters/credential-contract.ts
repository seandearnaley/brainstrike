import { addAbortListener } from 'node:events';
import {
  describeSecretReadError,
  isStoredKeyFingerprint,
  MalformedCredentialError,
  type ProviderCredential,
  parseStoredCredential,
  type SecretReadErrorCode,
  type StoredKeyFingerprint,
} from '@brainstrike/assistant-contract';

export type { ProviderCredential, SecretReadErrorCode } from '@brainstrike/assistant-contract';

/**
 * Completion here means the underlying native operation finished. In particular,
 * rejecting a caller's promise on abort is not a native completion receipt.
 */
export interface KeyringNativeEntry {
  deleteCredential(): Promise<boolean>;
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
}

export interface KeyringEntryRequest {
  readonly account: string;
  readonly options: { readonly linux: { readonly store: 'secret-service' } };
  readonly service: string;
}

/**
 * The platform owner supplies the execution lane, including entry construction.
 * These promises must join actual native completion and receive no AbortSignal.
 * The native implementation belongs to the supplied, profile-scoped backend.
 */
export interface KeyringCredentialBackend {
  close?(): Promise<void>;
  createEntry(request: KeyringEntryRequest): Promise<KeyringNativeEntry>;
  listAccounts(request: Omit<KeyringEntryRequest, 'account'>): Promise<readonly string[]>;
}

export interface CredentialStoreCompletion {
  readonly pendingNativeOperations: number;
  readonly queuedOperations: number;
  readonly state: 'open' | 'closing' | 'closed';
}

export interface KeyringCredentialStore {
  close(): Promise<{ readonly pendingNativeOperations: 0 }>;
  completion(): CredentialStoreCompletion;
  delete(account: string, signal?: AbortSignal): Promise<boolean>;
  /** Join admitted work without closing the shared credential authority. */
  join(): Promise<void>;
  listAccounts(signal?: AbortSignal): Promise<readonly string[]>;
  read(account: string, signal?: AbortSignal): Promise<string | null>;
  write(account: string, value: string, signal?: AbortSignal): Promise<void>;
}

export type CredentialStoreOperation = 'read' | 'write' | 'delete' | 'list' | 'close';

export class CredentialStoreUnavailableError extends Error {
  readonly code = 'credential_store_unavailable';
  readonly operation: CredentialStoreOperation;

  constructor(operation: CredentialStoreOperation, cause: unknown) {
    super('The configured OS credential store could not complete the operation.', { cause });
    this.name = 'CredentialStoreUnavailableError';
    this.operation = operation;
  }
}

export class CredentialStoreClosedError extends Error {
  readonly code = 'credential_store_closed';

  constructor() {
    super('The credential store is closing or closed.');
    this.name = 'CredentialStoreClosedError';
  }
}

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

export function observeCredentialCancellation<T>(
  completion: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return completion;
  }
  return new Promise<T>((resolve, reject) => {
    const listener = addAbortListener(signal, () => reject(signal.reason));
    completion.then(
      (value) => {
        listener[Symbol.dispose]();
        resolve(value);
      },
      (error: unknown) => {
        listener[Symbol.dispose]();
        reject(error);
      }
    );
  });
}

export async function joinCredentialCleanup(
  operations: readonly Promise<unknown>[],
  message: string,
  followUp?: () => readonly Promise<unknown>[]
): Promise<void> {
  const settled = await Promise.allSettled(operations);
  if (followUp) {
    settled.push(...(await Promise.allSettled(followUp())));
  }
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}
