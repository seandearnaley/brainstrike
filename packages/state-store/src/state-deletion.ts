// Purge, thread deletion and blob GC, in the order that keeps a crash recoverable and a referenced blob alive. The
// desktop StateStore and the browser writer (@brainstrike/web-state-store) both run this orchestration: each supplies
// its writer's deletion ops (`deletion-domain.mjs` underneath), its derived index and its write chain.
import { IndexerRequiredError } from './errors.js';
import { blobsOf, TOMBSTONE_BODY, withSeq } from './run-log-format.mjs';
import type { IndexerPort, PurgeReport } from './state-store-types.js';

export type { IndexerPort, PurgeReport } from './state-store-types.js';

/** A purge (`event`) or thread delete recorded before it started; `hashes` are the blobs it may free. */
export interface DeletionIntent {
  readonly hashes: readonly string[];
  readonly operation: 'event' | 'thread';
  readonly seq: number;
  readonly threadId: string;
}

/** The writer's deletion ops, on its connection, in the order the orchestration calls them. */
export interface DeletionWriter {
  acknowledgeSourceGc(hashes: readonly string[]): Promise<void>;
  /** Blob references of damaged threads: outside the verified count, yet still named by rows. */
  damagedBlobRefs(): Promise<readonly string[]>;
  deleteIntent(threadId: string, seq: number): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /** The stored body of event `seq`, or undefined when the thread has no event at `seq`. */
  eventRaw(threadId: string, seq: number): Promise<string | undefined>;
  intents(): Promise<readonly DeletionIntent[]>;
  okThreads(): Promise<readonly string[]>;
  purge(threadId: string, seq: number, tombstone: string): Promise<void>;
  /** Records `intent` unless one exists for its event; returns the hashes of the one recorded first. */
  recordIntent(intent: DeletionIntent): Promise<readonly string[]>;
  sourceBlobRefs(): Promise<readonly string[]>;
  sourceGcCandidates(): Promise<readonly string[]>;
  storedBlobRefs(threadId: string): Promise<readonly string[]>;
  /** Unlinks blobs; returns those that existed. */
  unlinkBlobs(hashes: readonly string[]): Promise<readonly string[]>;
}

export interface StateDeletionOptions {
  /** The derived index that counts blob references; deletion is refused without one. */
  readonly indexer: () => IndexerPort | undefined;
  /** Runs after a purge's truth commits, before the derived index reindexes (the crash harness). */
  readonly purgeAfterTruth?: () => void;
  /** The writer's one write chain: a purge's GC must never race an append that names the blob. */
  readonly run: <T>(work: () => T | Promise<T>) => Promise<T>;
}

export class StateDeletion {
  readonly #writer: DeletionWriter;
  readonly #options: StateDeletionOptions;
  readonly #deferred = new Set<string>();
  /** Exports in flight plus holdBlobGc holders: while any holds, unreferenced blobs wait in `#deferred`. */
  #holds = 0;

  constructor(writer: DeletionWriter, options: StateDeletionOptions) {
    this.#writer = writer;
    this.#options = options;
  }

  requireIndexer(operation: string): IndexerPort {
    const indexer = this.#options.indexer();
    if (!indexer) {
      throw new IndexerRequiredError(operation);
    }
    return indexer;
  }

  /**
   * Defers blob unlinking until the returned release runs (each release counts once). A reader that holds threads it
   * could not fold, whose blob references no count sees, holds collection while they exist.
   */
  holdBlobGc(): () => Promise<void> {
    this.#holds++;
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.#release();
    };
  }

  async #release(): Promise<void> {
    this.#holds--;
    if (this.#holds === 0 && this.#deferred.size > 0) {
      const pending = [...this.#deferred];
      this.#deferred.clear();
      const indexer = this.requireIndexer('blob GC');
      await this.#options.run(async () => {
        await this.#gc(indexer, pending);
        await this.collectRetiredSources();
      });
    }
  }

  /**
   * In the write chain, when the writer opens healthy: completes every purge or thread delete a crash interrupted,
   * then collects the sources the catalog retired.
   */
  async recover(): Promise<void> {
    const intents = await this.#writer.intents();
    if (intents.length > 0) {
      const indexer = this.requireIndexer('completing an interrupted purge');
      for (const intent of intents) {
        if (intent.operation === 'thread') {
          await this.#completeThreadDelete(indexer, intent.threadId, intent.hashes);
        } else {
          await this.#completePurge(indexer, intent.threadId, intent.seq, intent.hashes);
        }
      }
    }
    await this.collectRetiredSources();
  }

  /** In the write chain: the writer commits retirement candidates with source changes; GC owns physical erasure. */
  async collectRetiredSources(): Promise<void> {
    const hashes = await this.#writer.sourceGcCandidates();
    if (hashes.length === 0) {
      return;
    }
    const indexer = this.requireIndexer('canonical source retirement');
    await this.#gc(indexer, hashes);
    if (this.#holds === 0) {
      await this.#writer.acknowledgeSourceGc(hashes);
    }
  }

  /**
   * Purge event `seq`: when this resolves no byte of it is left in the state DB files, the derived store or the blobs
   * (M0-A2 item 1). An intent is recorded first, so a crash at any point is completed by the next open.
   */
  async purge(threadId: string, seq: number): Promise<PurgeReport> {
    const indexer = this.requireIndexer('purge');
    return this.#options.run(async () => {
      const raw = await this.#writer.eventRaw(threadId, seq);
      if (raw === undefined) {
        throw new Error(`purge: ${threadId}#${seq} does not exist`);
      }
      const hashes = await this.#writer.recordIntent({
        hashes: blobsOf(raw),
        operation: 'event',
        seq,
        threadId,
      });
      return this.#completePurge(indexer, threadId, seq, hashes);
    });
  }

  /** Idempotent: also replays an intent left by a crash at any point. */
  async #completePurge(
    indexer: IndexerPort,
    threadId: string,
    seq: number,
    hashes: readonly string[]
  ): Promise<PurgeReport> {
    const t0 = performance.now();
    await this.#writer.purge(threadId, seq, withSeq(seq, TOMBSTONE_BODY));
    const t1 = performance.now();
    this.#options.purgeAfterTruth?.();
    await indexer.reindex(threadId, seq);
    const t2 = performance.now();
    const deleted = await this.#gc(indexer, hashes);
    await this.#writer.deleteIntent(threadId, seq);
    const t3 = performance.now();
    return {
      blobsDeleted: deleted,
      derivedMs: t2 - t1,
      gcMs: t3 - t2,
      ms: t3 - t0,
      truthMs: t1 - t0,
    };
  }

  async deleteThread(threadId: string): Promise<string[]> {
    const indexer = this.requireIndexer('thread delete');
    return this.#options.run(async () => {
      // A held collection counts at release, so nothing needs the indexer current now.
      if (this.#holds === 0) {
        await indexer.catchUp(await this.#writer.okThreads());
      }
      // Stored references, verified or not: a thread whose rows failed verification still deletes.
      const hashes = await this.#writer.recordIntent({
        hashes: await this.#writer.storedBlobRefs(threadId),
        operation: 'thread',
        seq: 0,
        threadId,
      });
      return this.#completeThreadDelete(indexer, threadId, hashes);
    });
  }

  async #completeThreadDelete(
    indexer: IndexerPort,
    threadId: string,
    hashes: readonly string[]
  ): Promise<string[]> {
    await this.#writer.deleteThread(threadId);
    const references = await indexer.dropThread(threadId);
    const deleted = await this.#gc(indexer, [...new Set([...hashes, ...references])]);
    await this.#writer.deleteIntent(threadId, 0);
    return deleted;
  }

  /** Unlink blobs no event references any more. Runs in the chain after the indexer caught up with every thread. */
  async #gc(indexer: IndexerPort, hashes: readonly string[]): Promise<string[]> {
    if (hashes.length === 0) {
      return [];
    }
    // Held: the counts are taken at release. A holder may hold threads the indexer cannot yet read.
    if (this.#holds > 0) {
      for (const hash of hashes) {
        this.#deferred.add(hash);
      }
      return [];
    }
    const counts = await indexer.gcCheck(await this.#writer.okThreads(), hashes);
    // A damaged thread is outside the verified count, yet its rows still name blobs (RunLog.damagedBlobRefs).
    const held = new Set(await this.#writer.damagedBlobRefs());
    for (const hash of await this.#writer.sourceBlobRefs()) {
      held.add(hash);
    }
    const unlink: string[] = [];
    for (const hash of hashes) {
      const count = counts[hash];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new Error(`indexer returned an invalid reference count for blob ${hash}`);
      }
      if (count === 0 && !held.has(hash)) {
        unlink.push(hash);
      }
    }
    if (unlink.length === 0) {
      return [];
    }
    return [...(await this.#writer.unlinkBlobs(unlink))];
  }
}
