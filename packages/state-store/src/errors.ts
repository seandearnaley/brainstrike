/** A thread whose rows fail contiguity or their crc: reads stop at `atSeq`, appends are refused (M0-A2 item 3). */
export class ThreadDamagedError extends Error {
  readonly threadId: string;
  readonly atSeq: number;

  constructor(threadId: string, atSeq: number, detail: string) {
    super(`thread ${threadId} is damaged at seq ${atSeq}: ${detail}`);
    this.name = 'ThreadDamagedError';
    this.threadId = threadId;
    this.atSeq = atSeq;
  }
}

/** An append or purge refused because the thread is damaged. A refusal, so it does not fail the store. */
export class ThreadReadOnlyError extends Error {
  readonly threadId: string;
  /**
   * The state DB's own integrity finding when the whole store opened damaged
   * and read-only, so every thread refuses (BST-2144); null when only this
   * thread's history is damaged.
   */
  readonly storeDamage: string | null;

  constructor(threadId: string, message: string, storeDamage: string | null = null) {
    super(message);
    this.name = 'ThreadReadOnlyError';
    this.threadId = threadId;
    this.storeDamage = storeDamage;
  }
}

/**
 * A write refused because the state DB opened damaged and therefore read-only
 * (BST-2144). A refusal: nothing was written, every file is kept, and reads go
 * on. `damage` is the store's own integrity finding.
 */
export class StateStoreReadOnlyError extends Error {
  readonly damage: string;

  constructor(damage: string) {
    super(`the state store is read-only: database damaged: ${damage}`);
    this.name = 'StateStoreReadOnlyError';
    this.damage = damage;
  }
}

/** Purge and thread delete need the indexer: it re-derives the purged event and owns the blob reference counts. */
export class IndexerRequiredError extends Error {
  constructor(operation: string) {
    super(
      `${operation} needs the indexer port: the derived store re-indexes the purged event and owns the blob reference counts, so the store cannot complete it alone`
    );
    this.name = 'IndexerRequiredError';
  }
}
