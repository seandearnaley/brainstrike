import type { CanonicalWorkspaceRuntimeDependencies } from '@brainstrike/canonical-ingestion';
import { runWithTimeout } from '@brainstrike/effect-kit';
import type { IndexerOptions, IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import type { IndexerConnection, IndexerDeadlines } from '@brainstrike/indexer/transport';
import { app, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import {
  type CanonicalCollectionAttachment,
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
  type CanonicalWorkspaceAttachment,
} from './canonical-utility-parent';
import { assertCanonicalMessageBound, isCanonicalFrame } from './canonical-utility-protocol';

/** Main owns lifecycle only. SQLite and its writer worker belong to the utility process. */
export class IndexerHostManager {
  readonly databasePath: string;
  readonly acquisitionEmbedding: IndexerOptions['embedding'];
  readonly rootIds: readonly string[];
  readonly #options: IndexerOptions;
  readonly #deadlines: IndexerDeadlines;
  readonly #entryPath: string;
  #connection: IndexerConnection | undefined;
  #start: Promise<IndexerPort & ScopedIndexerPort> | undefined;
  #canonical: CanonicalUtilityParent | undefined;
  #exitCleanup: Promise<void> | undefined;
  #exitCleanupFailed = false;
  #transportFailure: unknown;
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

  start(): Promise<IndexerPort & ScopedIndexerPort> {
    if (this.#closed) {
      return Promise.reject(new Error('Indexer host is closed; create a fresh owner to restart.'));
    }
    if (!app.isReady()) {
      return Promise.reject(new Error('Indexer utility process requires Electron app readiness.'));
    }
    this.#start ??= this.#launch();
    return this.#start;
  }

  async #launch(): Promise<IndexerPort & ScopedIndexerPort> {
    const { createIndexerConnection } = await import('@brainstrike/indexer/transport');
    // close may race the dynamic import, before any process has been acquired.
    if (this.#closed) {
      throw new Error('Indexer host closed before launch.');
    }
    const child = utilityProcess.fork(this.#entryPath, [], { serviceName: 'brainstrike-indexer' });
    const protocolErrors = new Set<(error: unknown) => void>();
    const canonical = new CanonicalUtilityParent(
      (message) => {
        assertCanonicalMessageBound(message);
        child.postMessage(message);
      },
      (error) => {
        for (const notify of protocolErrors) {
          notify(error);
        }
      }
    );
    this.#canonical = canonical;
    this.#connection = createIndexerConnection(this.#options, this.#deadlines, {
      kill: () => child.kill(),
      onError: (listener) => {
        protocolErrors.add(listener);
        const error = (type: string, location: string, report: string): void =>
          listener(new Error(`Indexer utility process ${type} at ${location}: ${report}`));
        child.on('error', error);
        return () => {
          child.off('error', error);
          protocolErrors.delete(listener);
        };
      },
      onExit: (listener) => {
        const exit = (): void => {
          this.#exitCleanup ??= canonical.exited(new Error('Indexer utility exited.'));
          void this.#exitCleanup.catch(() => {
            this.#exitCleanupFailed = true;
          });
          listener();
        };
        child.on('exit', exit);
        return () => child.off('exit', exit);
      },
      onMessage: (listener) => {
        const message = (value: unknown): void => {
          if (!isCanonicalFrame(value)) {
            listener(value);
            return;
          }
          try {
            canonical.receive(value);
          } catch (error) {
            this.#transportFailure = error;
            for (const notify of protocolErrors) {
              notify(error);
            }
          }
        };
        child.on('message', message);
        return () => child.off('message', message);
      },
      send: (message) => child.postMessage(message),
    });
    const port = await this.#connection.ready;
    return { ...port, close: () => this.close(), destroy: () => this.destroy() };
  }

  async attachCanonicalWorkspace(
    dependencies: CanonicalWorkspaceRuntimeDependencies
  ): Promise<CanonicalWorkspaceAttachment> {
    await this.start();
    if (this.#closed || !this.#canonical) {
      throw new Error('Indexer canonical attachment admission is closed.');
    }
    const attachment = await this.#bounded(
      this.#canonical.attachWorkspace(dependencies),
      this.#deadlines.requestMs
    );
    return {
      cancel: () => this.#bounded(attachment.cancel(), this.#deadlines.requestMs),
      close: () => this.#bounded(attachment.close(), this.#deadlines.closeMs),
      trigger: () => this.#bounded(attachment.trigger(), this.#deadlines.requestMs),
    };
  }

  async attachCanonicalCollection(
    dependencies: CanonicalCollectionDependencies
  ): Promise<CanonicalCollectionAttachment> {
    await this.start();
    if (this.#closed || !this.#canonical) {
      throw new Error('Indexer canonical attachment admission is closed.');
    }
    const attachment = await this.#bounded(
      this.#canonical.attachCollection(dependencies),
      this.#deadlines.requestMs
    );
    return {
      cancel: () => this.#bounded(attachment.cancel(), this.#deadlines.requestMs),
      close: () => this.#bounded(attachment.close(), this.#deadlines.closeMs),
      scan: (requestId) => this.#bounded(attachment.scan(requestId), this.#deadlines.requestMs),
    };
  }

  #bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    return runWithTimeout(() => work, {
      onTimeout: () => {
        this.#closed = true;
        // Stop admission synchronously. The parent retains unfinished/failed retirement for close().
        const retirement = this.#canonical?.close();
        void retirement?.catch(() => {});
        return new Error(
          'Canonical utility request exceeded its explicit deadline; its owner remains retained for close.'
        );
      },
      timeoutMs,
    });
  }

  get exited(): boolean {
    return this.#connection?.exited ?? false;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#connection?.exited) {
      if (this.#exitCleanupFailed) {
        this.#exitCleanup = this.#canonical?.close();
        await this.#exitCleanup;
        this.#exitCleanupFailed = false;
      }
      await this.#exitCleanup;
      this.#reportTransportFailure();
      return;
    }
    await this.#bounded(this.#canonical?.close() ?? Promise.resolve(), this.#deadlines.closeMs);
    await this.#connection?.close();
    await this.#exitCleanup;
    this.#reportTransportFailure();
  }

  async destroy(): Promise<void> {
    this.#closed = true;
    if (!this.#connection) {
      throw new Error(
        'Indexer has not acquired a process; destroy requires its validated connection.'
      );
    }
    await this.#bounded(this.#canonical?.close() ?? Promise.resolve(), this.#deadlines.closeMs);
    await this.#connection.destroy();
    await this.#exitCleanup;
    this.#reportTransportFailure();
  }
  #reportTransportFailure(): void {
    if (this.#transportFailure === undefined) {
      return;
    }
    const error = this.#transportFailure;
    this.#transportFailure = undefined;
    throw error;
  }
}
