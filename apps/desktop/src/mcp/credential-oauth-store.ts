import { observeCredentialCancellation } from '@brainstrike/agent-host/credential-contract';
import type {
  McpOAuthPersistedState,
  McpOAuthStore,
  McpOAuthStoreIdentity,
} from './oauth-client-provider';
import { registerMcpOAuthStore } from './oauth-client-provider';

/** The injected object is the same credential authority used by provider auth. */
export interface McpOAuthCredentialStorage {
  delete(account: string, signal?: AbortSignal): Promise<boolean>;
  join(): Promise<void>;
  listAccounts(signal?: AbortSignal): Promise<readonly string[]>;
  read(account: string, signal?: AbortSignal): Promise<string | null>;
  write(account: string, value: string, signal?: AbortSignal): Promise<void>;
}

export interface CredentialMcpOAuthStoreOptions {
  /** Production binds the canonical identity hash and its account namespace. */
  readonly accountForIdentity: (identity: McpOAuthStoreIdentity) => string;
  readonly credentials: McpOAuthCredentialStorage;
  readonly ownsAccount: (account: string) => boolean;
  /** Production binds the existing persisted-state parser, rather than copying it. */
  readonly parseRecords: (
    raw: string
  ) =>
    | Readonly<Record<string, McpOAuthPersistedState>>
    | Promise<Readonly<Record<string, McpOAuthPersistedState>>>;
}

export interface CredentialMcpOAuthStore extends McpOAuthStore {
  clear(identity: McpOAuthStoreIdentity, signal?: AbortSignal): Promise<void>;
  clearAll(signal?: AbortSignal): Promise<void>;
  join(): Promise<void>;
  read(
    identity: McpOAuthStoreIdentity,
    signal?: AbortSignal
  ): Promise<Readonly<Record<string, McpOAuthPersistedState>>>;
  /** Release reset registration after the owning runtime has joined shutdown. */
  unregister(): void;
  write(
    identity: McpOAuthStoreIdentity,
    records: Readonly<Record<string, McpOAuthPersistedState>>,
    signal?: AbortSignal
  ): Promise<void>;
}

/**
 * Projects the existing MCP OAuth store onto an injected OS credential authority.
 * Account identity and validation remain canonical composition inputs. This owns
 * neither a second MCP runtime nor the lifetime of the shared credential store.
 */
export function createCredentialMcpOAuthStore(
  options: CredentialMcpOAuthStoreOptions
): CredentialMcpOAuthStore {
  let completionTail: Promise<void> = Promise.resolve();

  const account = (identity: McpOAuthStoreIdentity): string => {
    const result = options.accountForIdentity(identity);
    if (result.length === 0 || !options.ownsAccount(result)) {
      throw new Error('MCP OAuth credential account is outside the configured namespace.');
    }
    return result;
  };

  const enqueue = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    const completion = completionTail.then(async () => {
      signal?.throwIfAborted();
      return await operation();
    });
    completionTail = completion.then(
      () => undefined,
      () => undefined
    );
    return observeCredentialCancellation(completion, signal);
  };

  const result: CredentialMcpOAuthStore = {
    async clear(identity, signal) {
      const target = account(identity);
      await enqueue(async () => {
        await options.credentials.delete(target, signal);
      }, signal);
    },
    async clearAll(signal) {
      await enqueue(async () => {
        const accounts = await options.credentials.listAccounts(signal);
        const failures: unknown[] = [];
        for (const target of accounts) {
          signal?.throwIfAborted();
          if (options.ownsAccount(target)) {
            try {
              await options.credentials.delete(target, signal);
            } catch (error) {
              signal?.throwIfAborted();
              failures.push(error);
            }
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'MCP OAuth credential cleanup failed.');
        }
      }, signal);
    },
    async join() {
      await completionTail;
      await options.credentials.join();
    },
    async read(identity, signal) {
      const target = account(identity);
      return await enqueue(async () => {
        const raw = await options.credentials.read(target, signal);
        signal?.throwIfAborted();
        const records = raw === null ? {} : await options.parseRecords(raw);
        signal?.throwIfAborted();
        return records;
      }, signal);
    },
    unregister() {
      unregister();
    },
    async write(identity, records, signal) {
      const target = account(identity);
      await enqueue(async () => {
        const raw = JSON.stringify(records);
        await options.parseRecords(raw);
        signal?.throwIfAborted();
        await options.credentials.write(target, raw, signal);
      }, signal);
    },
  };
  const unregister = registerMcpOAuthStore(result);
  return result;
}
