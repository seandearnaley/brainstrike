import type { VaultDirectoryHandleLike, VaultRootId } from './types';

/**
 * Documented persistence surface (FACTORY RESET CONTRACT): this IndexedDB
 * database stores the user's vault FileSystemDirectoryHandles (handles are
 * structured-cloneable; IndexedDB is the only place they can persist). It is
 * wiped by factory reset via the IndexedDB fallback list in
 * packages/preferences/src/settings/system/factory-reset-helpers.ts.
 */
export const NOTES_VAULT_IDB_NAME = 'brainstrike-notes-vault';
const STORE_NAME = 'vault-roots';
const DB_VERSION = 1;

export interface StoredVaultRoot {
  readonly addedAt: number;
  readonly handle: VaultDirectoryHandleLike;
  readonly name: string;
  readonly rootId: VaultRootId;
}

export interface VaultHandleStore {
  list(): Promise<StoredVaultRoot[]>;
  put(root: StoredVaultRoot): Promise<void>;
  remove(rootId: VaultRootId): Promise<void>;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(NOTES_VAULT_IDB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'rootId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open vault handle DB'));
  });
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Vault handle DB request failed'));
  });
}

async function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDatabase(factory);
  try {
    return await awaitRequest(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  } finally {
    db.close();
  }
}

/**
 * Creates the IndexedDB-backed vault root store. Pass the ambient
 * `globalThis.indexedDB`; environments without IndexedDB get an explicit
 * throw (NO SILENT FALLBACKS — the vault is capability-gated anyway).
 */
export function createVaultHandleStore(
  factory: IDBFactory | undefined = globalThis.indexedDB
): VaultHandleStore {
  if (!factory) {
    throw new Error('Notes vault requires IndexedDB to persist directory handles');
  }
  return {
    async list(): Promise<StoredVaultRoot[]> {
      const roots = await withStore(factory, 'readonly', (store) => store.getAll());
      return (roots as StoredVaultRoot[]).sort((a, b) => a.addedAt - b.addedAt);
    },
    async put(root: StoredVaultRoot): Promise<void> {
      await withStore(factory, 'readwrite', (store) => store.put(root));
    },
    async remove(rootId: VaultRootId): Promise<void> {
      await withStore(factory, 'readwrite', (store) => store.delete(rootId));
    },
  };
}
