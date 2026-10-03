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

  constructor(threadId: string, message: string) {
    super(message);
    this.name = 'ThreadReadOnlyError';
    this.threadId = threadId;
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
