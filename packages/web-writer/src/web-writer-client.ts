import type { WebStateStore } from '@brainstrike/web-state-store';
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

  /** Drops a thread whose truth is deleted; returns the blob hashes its rows named. */
  dropThread(threadId: string): Promise<readonly string[]> {
    return this.store.extension('index.dropThread', threadId) as Promise<readonly string[]>;
  }

  stats(threadId: string): Promise<unknown> {
    return this.store.extension('index.stats', threadId);
  }

  /** How the writer opened the index: its projection identity, and whether it rebuilt. */
  status(): Promise<WebDerivedIndexStatus> {
    return this.store.extension('index.status', {}) as Promise<WebDerivedIndexStatus>;
  }
}
