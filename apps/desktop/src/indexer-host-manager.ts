import type { IndexerOptions, IndexerPort } from '@brainstrike/indexer';
import type { IndexerConnection, IndexerDeadlines } from '@brainstrike/indexer/transport';
import { app, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';

/** Main owns lifecycle only. SQLite and its writer worker belong to the utility process. */
export class IndexerHostManager {
  readonly databasePath: string;
  readonly acquisitionEmbedding: IndexerOptions['embedding'];
  readonly rootIds: readonly string[];
  readonly #options: IndexerOptions;
  readonly #deadlines: IndexerDeadlines;
  readonly #entryPath: string;
  #connection: IndexerConnection | undefined;
  #start: Promise<IndexerPort> | undefined;
  #closed = false;

  private constructor(options: IndexerOptions, deadlines: IndexerDeadlines, entryPath: string) {
    const embedding =
      options.embedding.indexMode === 'vector-configured'
        ? Object.freeze({
            ...options.embedding,
            profile: Object.freeze({ ...options.embedding.profile }),
          })
        : Object.freeze({ ...options.embedding });
    this.#options = { ...options, embedding, rootIds: Object.freeze([...options.rootIds]) };
    this.#deadlines = deadlines;
    this.#entryPath = entryPath;
    this.databasePath = options.dbPath;
    this.acquisitionEmbedding = embedding;
    this.rootIds = this.#options.rootIds;
  }

  static async create(
    input: unknown,
    deadlineInput: unknown,
    entryPath = resolveBundledSiblingPath('Indexer host', 'indexer-host-entry.js')
  ): Promise<IndexerHostManager> {
    const { validateIndexerOptions, validateIndexerDeadlines } = await import(
      '@brainstrike/indexer/transport'
    );
    return new IndexerHostManager(
      validateIndexerOptions(input),
      validateIndexerDeadlines(deadlineInput),
      entryPath
    );
  }

  start(): Promise<IndexerPort> {
    if (this.#closed) {
      return Promise.reject(new Error('Indexer host is closed; create a fresh owner to restart.'));
    }
    if (!app.isReady()) {
      return Promise.reject(new Error('Indexer utility process requires Electron app readiness.'));
    }
    this.#start ??= this.#launch();
    return this.#start;
  }

  async #launch(): Promise<IndexerPort> {
    const { createIndexerConnection } = await import('@brainstrike/indexer/transport');
    // close may race the dynamic import, before any process has been acquired.
    if (this.#closed) {
      throw new Error('Indexer host closed before launch.');
    }
    const child = utilityProcess.fork(this.#entryPath, [], { serviceName: 'brainstrike-indexer' });
    this.#connection = createIndexerConnection(this.#options, this.#deadlines, {
      kill: () => child.kill(),
      onError: (listener) => {
        const error = (type: string, location: string, report: string): void =>
          listener(new Error(`Indexer utility process ${type} at ${location}: ${report}`));
        child.on('error', error);
        return () => child.off('error', error);
      },
      onExit: (listener) => {
        child.on('exit', listener);
        return () => child.off('exit', listener);
      },
      onMessage: (listener) => {
        child.on('message', listener);
        return () => child.off('message', listener);
      },
      send: (message) => child.postMessage(message),
    });
    return this.#connection.ready;
  }

  get exited(): boolean {
    return this.#connection?.exited ?? false;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#connection?.close();
  }

  async destroy(): Promise<void> {
    this.#closed = true;
    if (!this.#connection) {
      throw new Error(
        'Indexer has not acquired a process; destroy requires its validated connection.'
      );
    }
    await this.#connection.destroy();
  }
}
