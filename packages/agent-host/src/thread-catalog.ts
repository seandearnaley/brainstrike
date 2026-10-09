import type { HydrationThread, LogRow, StateStore } from '@brainstrike/state-store';
import { readHostRow, readHostThreadHistory } from './event-storage.js';
import type { HostHookTrustStore } from './hook-trust.js';
import type { HostLogRow } from './protocol.js';

/** The Root store Core opens over and commits to. */
export type HostEventStore = HostHookTrustStore &
  Pick<StateStore, 'append' | 'holdBlobGc' | 'read' | 'readHydration' | 'root' | 'syncBoundary'> & {
    readonly deleteThread?: StateStore['deleteThread'];
  };

interface ThreadTimes {
  readonly createdAt: number;
  readonly updatedAt: number;
}

type DecodedThread =
  | { readonly rows: readonly HostLogRow[] }
  | { readonly damage: string; readonly head?: HostLogRow };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** A damaged thread keeps its first row when that still decodes: its origin lists a child under its parent. */
async function damaged(
  store: HostEventStore,
  damage: string,
  first: LogRow | undefined
): Promise<DecodedThread> {
  if (first?.seq !== 1) {
    return { damage };
  }
  try {
    return { damage, head: await readHostRow(store, first) };
  } catch {
    return { damage };
  }
}

/**
 * A thread's hydration rows, decoded. Damage the store reports (a crc or seq failure) and a row the host cannot decode
 * (a missing or altered blob, an event its schema rejects) make the thread unreadable.
 */
async function decodeThread(
  store: HostEventStore,
  stored: HydrationThread
): Promise<DecodedThread> {
  if (stored.damage) {
    return damaged(store, stored.damage.message, stored.rows[0]);
  }
  try {
    return { rows: await Promise.all(stored.rows.map((row) => readHostRow(store, row))) };
  } catch (cause) {
    return damaged(store, messageOf(cause), stored.rows[0]);
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
   * Folds every stored thread from one hydration read: a readable thread's rows, and a damaged thread's first row only,
   * so one unreadable row never stops the host from opening.
   */
  async hydrate(
    store: HostEventStore,
    threads: Set<string>,
    fold: (row: HostLogRow) => void
  ): Promise<void> {
    for (const stored of await store.readHydration()) {
      const { createdAt, threadId, updatedAt } = stored;
      threads.add(threadId);
      this.times.set(threadId, { createdAt, updatedAt });
      const decoded = await decodeThread(store, stored);
      if ('damage' in decoded) {
        this.damaged.set(threadId, decoded.damage);
        if (decoded.head) {
          fold(decoded.head);
        }
        continue;
      }
      for (const row of decoded.rows) {
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

  /** A thread's committed history; a damaged thread refuses with the reason its listing names. */
  readHistory(
    store: HostEventStore,
    threads: ReadonlySet<string>,
    threadId: string,
    fromSeq: number
  ): Promise<HostLogRow[]> {
    const damage = this.damaged.get(threadId);
    if (damage !== undefined) {
      return Promise.reject(new Error(`This thread's history cannot be read: ${damage}`));
    }
    return readHostThreadHistory(store, threads, threadId, fromSeq);
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
