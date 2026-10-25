import type { HostLogRow } from './protocol.ts';

export type HostRowListener = (row: HostLogRow, parentThreadId?: string) => void;

/**
 * Core's published log: the rows a client reads and its subscribers receive.
 * The store answers a read with every committed row, and Core commits a row
 * before it reads it back and folds it, so a client that acted on a row inside
 * that window would run ahead of Core (a child's end its parent's wake has not
 * seen). A client's read ends before the first such row; a subscriber receives
 * it once Core publishes it.
 */
export class HostPublishedRows {
  /** Each thread's committed rows Core has not yet folded and published. */
  private readonly folding = new Map<string, Set<number>>();
  private readonly listeners = new Set<HostRowListener>();
  private readonly readStored: (threadId: string, fromSeq: number) => Promise<HostLogRow[]>;

  constructor(readStored: (threadId: string, fromSeq: number) => Promise<HostLogRow[]>) {
    this.readStored = readStored;
  }

  /** Folds `committed` with `fold`, which publishes each row; until it settles, no client reads them. */
  async fold<T>(
    committed: readonly { readonly seq: number; readonly threadId: string }[],
    fold: () => Promise<T>
  ): Promise<T> {
    for (const { seq, threadId } of committed) {
      this.folding.set(threadId, (this.folding.get(threadId) ?? new Set<number>()).add(seq));
    }
    try {
      return await fold();
    } finally {
      for (const { seq, threadId } of committed) {
        const seqs = this.folding.get(threadId);
        seqs?.delete(seq);
        if (seqs?.size === 0) {
          this.folding.delete(threadId);
        }
      }
    }
  }

  /** Hands a folded row to every subscriber. */
  publish(row: HostLogRow, parentThreadId: string | undefined): void {
    for (const listener of this.listeners) {
      listener(row, parentThreadId);
    }
  }

  /** A client's read of `threadId`: its stored rows, ending before its first unpublished row. */
  async read(threadId: string, fromSeq: number): Promise<HostLogRow[]> {
    const rows = await this.readStored(threadId, fromSeq);
    const folding = this.folding.get(threadId);
    if (!folding) {
      return rows;
    }
    const first = Math.min(...folding);
    return rows.filter((row) => row.seq < first);
  }

  subscribe(listener: HostRowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Core's close: no subscriber receives another row. */
  close(): void {
    this.listeners.clear();
  }
}
