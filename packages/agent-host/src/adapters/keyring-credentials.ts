import {
  isProviderCredential,
  MalformedCredentialError,
  type ProviderCredential,
} from '@brainstrike/assistant-contract';
import {
  CredentialStoreClosedError,
  type CredentialStoreOperation,
  CredentialStoreUnavailableError,
  credentialToApiKey,
  type KeyringCredentialBackend,
  type KeyringCredentialStore,
  type KeyringEntryRequest,
  type KeyringNativeEntry,
  parseCredentialOrThrow,
  SecretReadError,
  type SecretsService,
} from './credential-contract.js';

export * from './credential-contract.js';

export interface KeyringCredentialStoreOptions {
  readonly backend: KeyringCredentialBackend;
  /** Supplied by production composition; never inferred from a user's profile. */
  readonly service: string;
}

function assertAccount(account: string): void {
  if (account.length === 0) {
    throw new TypeError('A credential account is required.');
  }
}

function observeCancellation<T>(completion: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return completion;
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    completion.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
    if (signal.aborted) {
      abort();
    }
  });
}

/**
 * Serializes the existing credential authority's persistence operations. Caller
 * cancellation fences queued work without cancelling the completion promise of
 * a running native call. OS work can wait indefinitely; close retains its join.
 */
export function createKeyringCredentialStore(
  options: KeyringCredentialStoreOptions
): KeyringCredentialStore {
  if (options.service.length === 0) {
    throw new TypeError('A profile-scoped credential service is required.');
  }
  const selection = { linux: { store: 'secret-service' as const } };
  let state: 'open' | 'closing' | 'closed' = 'open';
  let queuedOperations = 0;
  let pendingNativeOperations = 0;
  let completionTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<{ readonly pendingNativeOperations: 0 }> | undefined;
  const cancelledNativeFailures: CredentialStoreUnavailableError[] = [];

  const assertAdmitted = (signal?: AbortSignal): void => {
    signal?.throwIfAborted();
    if (state !== 'open') {
      throw new CredentialStoreClosedError();
    }
  };

  const native = async <T>(
    operation: CredentialStoreOperation,
    execute: () => Promise<T>
  ): Promise<T> => {
    pendingNativeOperations += 1;
    try {
      return await execute();
    } catch (error) {
      throw new CredentialStoreUnavailableError(operation, error);
    } finally {
      pendingNativeOperations -= 1;
    }
  };

  const entry = async (
    account: string,
    operation: CredentialStoreOperation,
    signal?: AbortSignal
  ): Promise<KeyringNativeEntry> => {
    const request: KeyringEntryRequest = {
      account,
      options: selection,
      service: options.service,
    };
    const created = await native(operation, () => options.backend.createEntry(request));
    // Construction can itself enter native work. A cancelled construction must
    // finish before it can be fenced from a subsequent read or mutation.
    assertAdmitted(signal);
    return created;
  };

  const enqueue = <T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    assertAdmitted(signal);
    queuedOperations += 1;
    const completion = completionTail
      .then(() => {
        queuedOperations -= 1;
        assertAdmitted(signal);
        return execute();
      })
      .catch((error: unknown) => {
        if (signal?.aborted && error instanceof CredentialStoreUnavailableError) {
          // The caller may already have observed cancellation. Retain a later
          // native failure for the owner joining the backend at shutdown/reset.
          cancelledNativeFailures.push(error);
        }
        throw error;
      });
    completionTail = completion.then(
      () => undefined,
      () => undefined
    );
    return observeCancellation(completion, signal);
  };

  return {
    close() {
      if (closePromise) {
        return closePromise;
      }
      state = 'closing';
      closePromise = completionTail.then(async () => {
        const failures: unknown[] = [...cancelledNativeFailures];
        let backendClosed = true;
        if (options.backend.close) {
          try {
            await native('close', () => options.backend.close?.() ?? Promise.resolve());
          } catch (error) {
            backendClosed = false;
            failures.push(error);
          }
        }
        if (backendClosed) {
          state = 'closed';
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Credential store cleanup completed with failures.');
        }
        return { pendingNativeOperations: 0 as const };
      });
      return closePromise;
    },
    completion() {
      return { pendingNativeOperations, queuedOperations, state };
    },
    async delete(account, signal) {
      assertAccount(account);
      return await enqueue(async () => {
        const target = await entry(account, 'delete', signal);
        assertAdmitted(signal);
        return await native('delete', () => target.deleteCredential());
      }, signal);
    },
    async join() {
      await completionTail;
      if (cancelledNativeFailures.length > 0) {
        throw new AggregateError(
          [...cancelledNativeFailures],
          'Credential operations completed with failures after caller cancellation.'
        );
      }
    },
    async listAccounts(signal) {
      return await enqueue(async () => {
        const accounts = await native('list', () =>
          options.backend.listAccounts({ options: selection, service: options.service })
        );
        return [...accounts];
      }, signal);
    },
    async read(account, signal) {
      assertAccount(account);
      return await enqueue(async () => {
        const target = await entry(account, 'read', signal);
        assertAdmitted(signal);
        return (await native('read', () => target.getPassword())) ?? null;
      }, signal);
    },
    async write(account, value, signal) {
      assertAccount(account);
      await enqueue(async () => {
        const target = await entry(account, 'write', signal);
        assertAdmitted(signal);
        await native('write', () => target.setPassword(value));
      }, signal);
    },
  };
}

export interface KeyringSecretsServiceOptions {
  readonly accountForProvider: (provider: string) => string;
  readonly credentials: KeyringCredentialStore;
  readonly providerForAccount: (account: string) => string | undefined;
}

/** Provider projection over the same injected authority used by MCP OAuth. */
export function createKeyringSecretsService(options: KeyringSecretsServiceOptions): SecretsService {
  const account = (provider: string): string => {
    const target = options.accountForProvider(provider);
    if (target.length === 0 || options.providerForAccount(target) !== provider) {
      throw new Error('Provider credential account is outside the configured namespace.');
    }
    return target;
  };

  const readCredential = async (provider: string): Promise<ProviderCredential | null> => {
    let raw: string | null;
    try {
      raw = await options.credentials.read(account(provider));
    } catch (error) {
      if (error instanceof CredentialStoreUnavailableError) {
        throw new SecretReadError('decrypt_failed', provider, error);
      }
      throw error;
    }
    return raw === null ? null : parseCredentialOrThrow(provider, raw);
  };

  const writeCredential = async (
    provider: string,
    credential: ProviderCredential
  ): Promise<boolean> => {
    if (!isProviderCredential(credential)) {
      throw new MalformedCredentialError(
        'setCredential received an invalid or unrecognized credential object'
      );
    }
    await options.credentials.write(account(provider), JSON.stringify(credential));
    return true;
  };

  return {
    async clearAll() {
      let success = true;
      const accounts = await options.credentials.listAccounts();
      for (const target of accounts) {
        if (options.providerForAccount(target) !== undefined) {
          try {
            await options.credentials.delete(target);
          } catch {
            success = false;
          }
        }
      }
      return success;
    },
    async deleteKey(provider) {
      return await options.credentials.delete(account(provider));
    },
    getCredential: readCredential,
    async getKey(provider) {
      const credential = await readCredential(provider);
      return credential === null ? null : credentialToApiKey(provider, credential);
    },
    async listProviders() {
      const accounts = await options.credentials.listAccounts();
      return accounts.flatMap((target) => {
        const provider = options.providerForAccount(target);
        return provider === undefined ? [] : [provider];
      });
    },
    async saveKey(provider, value) {
      return await writeCredential(provider, { key: value, type: 'api_key' });
    },
    setCredential: writeCredential,
  };
}
