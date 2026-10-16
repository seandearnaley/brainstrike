import { getFileSizeConfig } from '@brainstrike/file-system/config';
import { SCOPED_INDEX_OPERATIONS } from '@brainstrike/indexer/browser';
import { type WebStateExtension, webStateExtensionPool } from '@brainstrike/web-state-store';
import {
  type FileIndexMessage,
  type FileIndexRequest,
  fileIndexError,
  fileIndexFailure,
} from './file-index-protocol';

/** Version 6: the corpus cap. */
export const FILE_INDEX_EXTENSION_ID = 'file-index@6';

/**
 * The browser corpus cap (BST-1940; owner decision, 16 Oct): a scan that would
 * take the file index past it refuses visibly, and what is indexed stays.
 */
export const WEB_CORPUS_CHUNK_CAP = 25_000;

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
}
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** The writer's end of the file index worker: one request at a time per id, failures visible. */
class FileIndexWorker {
  readonly #pending = new Map<number, Pending>();
  readonly #worker: Worker;
  #failure: Error | undefined;
  #nextId = 1;

  /** `request` runs the worker's calls on the writer's own ops, in its request order. */
  constructor(request: (op: string, params: unknown) => Promise<unknown>) {
    this.#worker = new Worker(new URL('./file-index-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.#worker.onmessage = (event: MessageEvent<FileIndexMessage>) => {
      const message = event.data;
      if (message.kind === 'writer') {
        void request(message.op, message.params).then(
          (result) => this.#post({ id: message.id, kind: 'writer-reply', ok: true, result }),
          (error: unknown) =>
            this.#post({
              error: fileIndexError(error),
              id: message.id,
              kind: 'writer-reply',
              ok: false,
            })
        );
        return;
      }
      if (message.kind !== 'reply') {
        this.#fail(new Error('The file index worker sent a message outside its protocol'));
        return;
      }
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.ok) {
        pending?.resolve(message.result);
      } else {
        pending?.reject(fileIndexFailure(message.error));
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

  #post(message: FileIndexRequest): void {
    if (!this.#failure) {
      this.#worker.postMessage(message);
    }
  }

  send(request: WithoutId<Exclude<FileIndexRequest, { kind: 'writer-reply' }>>): Promise<unknown> {
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
 * plus:
 * - `files.configure`, which hands it the saved Search & Indexing
 *   preferences; the store opens, or reopens, under their partition;
 * - `files.reauthorize`, which reopens the store under the catalogs'
 *   current authority;
 * - `files.embedQuery`, which embeds a semantic search query with the saved
 *   collection's model, for `files.searchScopes` to search;
 * - `files.scan`, which ingests a live root's folder, as the tab hands it
 *   over, through canonical ingestion and answers with its receipt.
 */
export const fileIndexExtension: WebStateExtension = {
  id: FILE_INDEX_EXTENSION_ID,
  async open(context) {
    const names = webStateExtensionPool(context.config.name, 'files');
    const worker = new FileIndexWorker((op, params) => context.request(op, params));
    try {
      await worker.send({
        chunkCap: context.config.testHooks?.fileIndexChunkCap ?? WEB_CORPUS_CHUNK_CAP,
        kind: 'open',
        // As desktop's native index scans: the configured file size bound, 64 files a batch.
        scan: { batchSize: 64, maxFileBytes: getFileSizeConfig().maxFileSize },
        ...names,
      });
    } catch (error) {
      worker.terminate();
      throw error;
    }
    const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
      'files.configure': (params) => {
        const { embeddingWorkerUrl, preferences } = params as {
          readonly embeddingWorkerUrl?: string | null;
          readonly preferences: string | null;
        };
        return worker.send({
          embeddingWorkerUrl: embeddingWorkerUrl ?? null,
          kind: 'configure',
          preferences,
        });
      },
      'files.embedQuery': (params) => {
        const { query } = params as { readonly query: string };
        return worker.send({ kind: 'embed-query', query });
      },
      'files.reauthorize': () => worker.send({ kind: 'reauthorize' }),
      'files.scan': (params) => {
        const { folder, rootId } = params as {
          readonly folder: FileSystemDirectoryHandle;
          readonly rootId: string;
        };
        return worker.send({ folder, kind: 'scan', rootId });
      },
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
      // Index work runs in the worker's own order: a chat append never waits behind it.
      concurrent: Object.keys(handlers),
      handlers,
    };
  },
};
