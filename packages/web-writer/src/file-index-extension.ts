import { SCOPED_INDEX_OPERATIONS } from '@brainstrike/indexer/browser';
import {
  executeCollectionRequest,
  executeSourceCatalogRequest,
  executeWorkspaceRootRequest,
} from '@brainstrike/state-store/catalog-domains';
import {
  isWebRootPath,
  type WebStateExtension,
  type WebStateWriterContext,
  webRootPath,
  webStateExtensionPool,
} from '@brainstrike/web-state-store';
import { asBetterSqlite3 } from '@brainstrike/web-state-store/sqlite-wasm-database';
import type { FileIndexAuthority, FileIndexReply, FileIndexRequest } from './file-index-protocol';

export const FILE_INDEX_EXTENSION_ID = 'file-index@1';

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/**
 * The file index's authority, read from the writer's catalogs: the live
 * roots, every collection, and the files of either. A rooted file binds by
 * its root-relative path, as desktop's `nativeFileIdentity` binds it, with
 * its source named under the root's handle key.
 */
function authorityOf(context: WebStateWriterContext): FileIndexAuthority {
  const db = asBetterSqlite3(context.state);
  const roots = executeWorkspaceRootRequest(
    db,
    { operation: 'list' },
    { isGranted: (root) => isWebRootPath(root.path, root.preferredId) }
  ).roots.filter((root) => root.status === 'live');
  const live = new Set(roots.map((root) => root.id));
  const collections = executeCollectionRequest(db, { operation: 'list' }).collections;
  const files = executeSourceCatalogRequest(
    db,
    { operation: 'list' },
    {
      put: () => {
        throw new Error('The file index reads the catalog only');
      },
      read: () => null,
    }
  ).files.filter((file) => file.rootId === null || live.has(file.rootId));
  return {
    fileBindings: files.map((file) => ({
      embeddingSetId: file.embeddingSetId,
      fileId: file.fileId,
      profile: null,
      relativePath: file.rootId === null ? null : file.path,
      rootId: file.rootId,
      sourcePath: file.rootId === null ? file.path : `${webRootPath(file.rootId)}/${file.path}`,
    })),
    rootIds: [...live].sort(),
    scopes: collections.map((collection) => ({
      embeddingSetId: collection.id,
      kind: 'collection' as const,
    })),
  };
}

/** The writer's end of the file index worker: one request at a time per id, failures visible. */
class FileIndexWorker {
  readonly #pending = new Map<number, Pending>();
  readonly #worker: Worker;
  #failure: Error | undefined;
  #nextId = 1;

  constructor() {
    this.#worker = new Worker(new URL('./file-index-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.#worker.onmessage = (event: MessageEvent<FileIndexReply>) => {
      const reply = event.data;
      const pending = this.#pending.get(reply.id);
      this.#pending.delete(reply.id);
      if (reply.ok) {
        pending?.resolve(reply.result);
      } else {
        pending?.reject(Object.assign(new Error(reply.error.message), reply.error));
      }
    };
    this.#worker.onerror = (event) => {
      this.#fail(new Error(`The file index worker failed: ${event.message}`));
    };
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  send(request: WithoutId<FileIndexRequest>): Promise<unknown> {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#worker.postMessage({ ...request, id });
    });
  }

  terminate(): void {
    this.#fail(new Error('The file index worker is closed'));
    this.#worker.terminate();
  }
}

/**
 * The web workspace file index (ADR-0022, 2026-10-16 amendment): a worker
 * the writer starts, with the scoped store in its own pool beside the
 * store's, under the writer's lease. Its ops are desktop's
 * `ScopedIndexerPort` (`files.prepareScopedFile`, `files.searchScopes`, ...),
 * plus `files.reauthorize`, which reopens the store under the catalogs'
 * current authority.
 */
export const fileIndexExtension: WebStateExtension = {
  id: FILE_INDEX_EXTENSION_ID,
  async open(context) {
    const names = webStateExtensionPool(context.config.name, 'files');
    const worker = new FileIndexWorker();
    try {
      await worker.send({ authority: authorityOf(context), kind: 'open', ...names });
    } catch (error) {
      worker.terminate();
      throw error;
    }
    const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
      'files.reauthorize': () =>
        worker.send({ authority: authorityOf(context), kind: 'reauthorize' }),
    };
    for (const op of SCOPED_INDEX_OPERATIONS) {
      handlers[`files.${op}`] = (params) => worker.send({ kind: 'request', op, params });
    }
    return {
      close: async () => {
        try {
          await worker.send({ kind: 'close' });
        } finally {
          worker.terminate();
        }
      },
      handlers,
    };
  },
};
