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
