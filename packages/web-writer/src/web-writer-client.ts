import type { CanonicalScanReceipt } from '@brainstrike/canonical-ingestion/browser';
import type {
  CommitResult,
  IndexerPort,
  ScopedCoverage,
  ScopedFileChunkBounds,
  ScopedFilePage,
  ScopedFilePlan,
  ScopedIndexerPort,
  ScopedManifestResult,
  ScopedSearchResult,
} from '@brainstrike/indexer';
import { IndexerError } from '@brainstrike/indexer/browser';
import { type WebStateStore, WebStateStoreError } from '@brainstrike/web-state-store';
import type { WebDerivedIndexStatus } from './derived-index-extension';

/** One state search hit, as the desktop's host state index returns it. */
export interface StateSearchHit {
  readonly rank: number;
  readonly role: 'assistant' | 'user';
  readonly runId: string;
  readonly seq: number;
  readonly snippet: string;
  readonly threadId: string;
}

/** A thread's projection, as the derived index reports it. */
export interface StateProjectionStats {
  readonly cursor: number;
  readonly docs: number;
  readonly gaps: readonly { readonly from: number; readonly reason: string; readonly to: number }[];
}

/**
 * A tab's handle on the derived index its writer composes: the requests the
 * desktop's IndexerPort sends its host state index.
 */
export class WebDerivedIndex {
  constructor(private readonly store: WebStateStore) {}

  /** Projects every committed row the index has not seen yet, of `threadIds` or of every thread. */
  catchUp(threadIds?: readonly string[]): Promise<boolean> {
    return this.store.extension(
      'index.catchUp',
      threadIds ? { threadIds } : {}
    ) as Promise<boolean>;
  }

  /** History search over committed runs, catching up the threads first. */
  search(request: {
    readonly limit: number;
    readonly match?: 'all' | 'any';
    readonly query: string;
    readonly threadIds: readonly string[];
  }): Promise<readonly StateSearchHit[]> {
    return this.store.extension('index.search', request) as Promise<readonly StateSearchHit[]>;
  }

  /** How many projected rows still name each blob, after catching up `threads`. */
  gcCheck(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>> {
    return this.store.extension('index.gcCheck', { hashes, threads }) as Promise<
      Readonly<Record<string, number>>
    >;
  }

  /** A thread's projection: its cursor, its searchable documents, and the gaps it skipped. */
  stats(threadId: string): Promise<StateProjectionStats> {
    return this.store.extension('index.stats', threadId) as Promise<StateProjectionStats>;
  }

  /** How the writer opened the index: its projection identity, and whether it rebuilt. */
  status(): Promise<WebDerivedIndexStatus> {
    return this.store.extension('index.status', {}) as Promise<WebDerivedIndexStatus>;
  }
}

/**
 * A tab's handle on the file index its writer runs in a worker of its own:
 * desktop's `ScopedIndexerPort`, so the shared publication owner takes it as
 * it takes desktop's.
 */
export class WebFileIndex implements ScopedIndexerPort, Pick<IndexerPort, 'info'> {
  constructor(private readonly store: WebStateStore) {}

  /** A coded refusal arrives as desktop's port raises it: an IndexerError with its code. */
  async #call<T>(op: string, params: unknown): Promise<T> {
    try {
      return (await this.store.extension(`files.${op}`, params)) as T;
    } catch (error) {
      if (error instanceof WebStateStoreError && error.code !== undefined) {
        throw new IndexerError(error.code, error.message);
      }
      throw error;
    }
  }

  /**
   * Ingests a live root's folder through canonical ingestion, into the
   * source catalog and the index; resolves with the pass's receipt. `folder`
   * is the handle this tab holds the user's grant for: the browser asks for
   * a grant in a window, never in a worker.
   */
  scan(rootId: string, folder: FileSystemDirectoryHandle): Promise<CanonicalScanReceipt> {
    return this.#call('scan', { folder, rootId });
  }

  /**
   * Hands the index the saved Search & Indexing preferences, exactly as the
   * visible settings stored them (`NATIVE_INDEX_SETTINGS_KEY`), or null when
   * none are saved; the writer reads them as desktop main does. The store
   * opens, or reopens, under their partition; until then every op refuses.
   * Settings that fail refuse, and leave the index refusing with their failure.
   * VECTOR search embeds a local model with `embeddingWorkerUrl`, the embedding
   * worker as this tab's bundle serves it (`resolveViteEmbeddingWorkerUrlHref`).
   */
  configure(
    preferences: string | null,
    embeddingWorkerUrl?: string
  ): Promise<{ readonly rebuilt: string | null }> {
    return this.#call('configure', { embeddingWorkerUrl: embeddingWorkerUrl ?? null, preferences });
  }

  /** Reopens the store under the saved partition's current roots, collection and files. */
  reauthorize(): Promise<{ readonly rebuilt: string | null }> {
    return this.#call('reauthorize', {});
  }

  info(): ReturnType<IndexerPort['info']> {
    return this.#call('info', null);
  }
  commitScopedFile(commit: unknown): Promise<CommitResult> {
    return this.#call('commitScopedFile', commit);
  }
  commitScopedTextFile(commit: unknown): Promise<CommitResult> {
    return this.#call('commitScopedTextFile', commit);
  }
  coverageBatch(requests: unknown): Promise<readonly ScopedCoverage[]> {
    return this.#call('coverageBatch', requests);
  }
  coverageScope(request: unknown): Promise<ScopedCoverage> {
    return this.#call('coverageScope', request);
  }
  prepareScopedFile(request: unknown): Promise<ScopedFilePlan> {
    return this.#call('prepareScopedFile', request);
  }
  readScopedFileChunkBounds(request: unknown): Promise<ScopedFileChunkBounds> {
    return this.#call('readScopedFileChunkBounds', request);
  }
  readScopedFilePage(request: unknown): Promise<ScopedFilePage> {
    return this.#call('readScopedFilePage', request);
  }
  removeScopedFile(identity: unknown): Promise<boolean> {
    return this.#call('removeScopedFile', identity);
  }
  replaceFileBindings(bindings: unknown): Promise<void> {
    return this.#call('replaceFileBindings', bindings);
  }
  searchScopes(request: unknown): Promise<ScopedSearchResult> {
    return this.#call('searchScopes', request);
  }
  verifyScopedManifest(request: unknown): Promise<ScopedManifestResult> {
    return this.#call('verifyScopedManifest', request);
  }
}
