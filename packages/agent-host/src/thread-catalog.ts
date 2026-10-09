import { type StateStore, ThreadDamagedError } from '@brainstrike/state-store';
import { readHostRow } from './event-storage.js';
import type { HostHookTrustStore } from './hook-trust.js';
import type { HostLogRow } from './protocol.js';

/** The Root store Core opens over and commits to. */
export type HostEventStore = HostHookTrustStore &
  Pick<
    StateStore,
    'append' | 'holdBlobGc' | 'read' | 'root' | 'syncBoundary' | 'threads' | 'threadTimes'
  > & {
    readonly deleteThread?: StateStore['deleteThread'];
  };

interface ThreadTimes {
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A damaged thread's first row, when it is still readable: its origin lists a child under its parent. */
async function readHead(store: HostEventStore, threadId: string): Promise<HostLogRow | undefined> {
  try {
    const [head] = await store.read(threadId, 1, 1);
    return head ? await readHostRow(store, head) : undefined;
  } catch {
    return;
  }
}

/** A stored row that cannot be read: the store's verification failed, or the host cannot decode it. */
class UnreadableThread extends Error {}

/**
 * A thread's rows, decoded. Damage the store reports (a crc or seq failure) and a row the host cannot decode (a
 * missing or altered blob, an event its schema rejects) make the thread unreadable; any other failure (the writer
 * failing, the store closing) is the store's and still fails the open.
 */
async function readStoredThread(store: HostEventStore, threadId: string): Promise<HostLogRow[]> {
  let stored: Awaited<ReturnType<HostEventStore['read']>>;
  try {
    stored = await store.read(threadId);
  } catch (cause) {
    if (cause instanceof ThreadDamagedError) {
      throw new UnreadableThread(cause.message);
    }
    throw cause;
  }
  try {
    return await Promise.all(stored.map((row) => readHostRow(store, row)));
  } catch (cause) {
    throw new UnreadableThread(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Each stored thread's catalog facts: its first and latest append (the store's own times, so a thread whose rows cannot
 * be read still dates honestly) and, for such a thread, its damage. A damaged thread is listed and deletable but never
 * runs, and while one exists blob collection is held: its references are not counted, and blobs are shared by content.
 */
export class HostThreadCatalog {
  private readonly times = new Map<string, ThreadTimes>();
  private readonly damaged = new Map<string, string>();
  private releaseGc: (() => Promise<void>) | undefined;

  /**
   * Folds every stored thread: a readable thread's rows, and a damaged thread's first row only, so one unreadable row
   * never stops the host from opening.
   */
  async hydrate(
    store: HostEventStore,
    threads: Set<string>,
    fold: (row: HostLogRow) => void
  ): Promise<void> {
    for (const { threadId, ...times } of await store.threadTimes()) {
      this.times.set(threadId, times);
    }
    for (const threadId of await store.threads()) {
      threads.add(threadId);
      let rows: HostLogRow[];
      try {
        rows = await readStoredThread(store, threadId);
      } catch (cause) {
        if (!(cause instanceof UnreadableThread)) {
          throw cause;
        }
        this.damaged.set(threadId, cause.message);
        const head = await readHead(store, threadId);
        if (head) {
          fold(head);
        }
        continue;
      }
      for (const row of rows) {
        fold(row);
      }
    }
    if (this.damaged.size > 0) {
      this.releaseGc = store.holdBlobGc();
    }
  }

  /** A committed row's append time is the store's latest time for its thread. */
  noteCommitted(rows: readonly HostLogRow[]): void {
    for (const { threadId, ts } of rows) {
      if (ts !== undefined) {
        this.times.set(threadId, {
          createdAt: this.times.get(threadId)?.createdAt ?? ts,
          updatedAt: ts,
        });
      }
    }
  }

  /** The catalog facts `thread/list` carries for a thread. */
  entry(threadId: string): ThreadTimes & { readonly damage?: string } {
    const times = this.times.get(threadId);
    if (!times) {
      throw new Error(`Thread ${threadId} has no stored append time`);
    }
    const damage = this.damaged.get(threadId);
    return damage === undefined ? times : { ...times, damage };
  }

  assertRunnable(threadId: string): void {
    const damage = this.damaged.get(threadId);
    if (damage !== undefined) {
      throw new Error(`This thread's history cannot be read, so it cannot run: ${damage}`);
    }
  }

  /** A deleted thread leaves the catalog; the last damaged one releases blob collection. */
  async forget(threadId: string): Promise<void> {
    this.times.delete(threadId);
    this.damaged.delete(threadId);
    if (this.damaged.size === 0 && this.releaseGc) {
      const release = this.releaseGc;
      this.releaseGc = undefined;
      await release();
    }
  }
}
