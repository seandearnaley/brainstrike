/**
 * A browser writer in Node for the host client's tests: each thread's log and
 * the blobs its rows name, every append announced to every client after it
 * commits (as `subscribeLog` does), and a store name scoping the Web Locks its
 * clients share, as tabs share them.
 */
import type {
  WebStateLogAppend,
  WebStateStore,
  WebStateStoredRow,
} from '@brainstrike/web-state-store';

type AppendRow = readonly [string, string, string | null, string, number | null, number];

export interface ScriptedWriter {
  /** Commits rows as another tab would, announced like any append. */
  readonly append: (rows: readonly AppendRow[]) => Promise<void>;
  readonly logs: ReadonlyMap<string, readonly WebStateStoredRow[]>;
  /** From now on every append is refused with `reason`, as a closed store refuses one. */
  readonly refuseAppends: (reason: string) => void;
  readonly store: WebStateStore;
}

export function scriptedWriter(): ScriptedWriter {
  const logs = new Map<string, WebStateStoredRow[]>();
  const blobs = new Map<string, string>();
  const listeners = new Set<(append: WebStateLogAppend) => void>();
  let ts = 0;
  let refusal: string | undefined;
  const append = async (rows: readonly AppendRow[]) => {
    if (refusal) {
      throw new Error(refusal);
    }
    ts += 1;
    const appended = new Map<string, number[]>();
    const seqs = rows.map(([threadId, , , payload]) => {
      const log = logs.get(threadId) ?? [];
      logs.set(threadId, log);
      const seq = log.length + 1;
      log.push({
        crc: 0,
        payload: JSON.stringify({ seq, ...JSON.parse(payload) }),
        rawCount: null,
        seq,
        ts,
      });
      appended.set(threadId, [...(appended.get(threadId) ?? []), seq]);
      return seq;
    });
    // Announced once committed, to every client, the appending one too.
    queueMicrotask(() => {
      for (const [threadId, threadSeqs] of appended) {
        for (const listener of listeners) {
          listener({ seqs: threadSeqs, threadId });
        }
      }
    });
    return { seqs, ts };
  };
  const store = {
    append,
    deleteThread: async (threadId: string) => {
      logs.delete(threadId);
      return { deleted: true };
    },
    name: `scripted-${crypto.randomUUID().slice(0, 8)}`,
    putBlob: async (hash: string, content: string) => {
      blobs.set(hash, content);
      return { stored: true };
    },
    read: async (threadId: string, fromSeq: number, limit: number) => ({
      damage: null,
      rows: (logs.get(threadId) ?? []).filter((row) => row.seq >= fromSeq).slice(0, limit),
    }),
    readBlob: async (hash: string) => ({ content: blobs.get(hash) ?? null }),
    readHydration: async () => ({
      threads: [...logs].map(([threadId, rows]) => ({
        createdAt: rows[0]?.ts ?? 0,
        damage: null,
        rows: [...rows],
        threadId,
        updatedAt: rows.at(-1)?.ts ?? 0,
      })),
    }),
    subscribeLog: (listener: (append: WebStateLogAppend) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    threads: async () => ({ threads: [...logs.keys()] }),
  } as unknown as WebStateStore;
  return {
    append: async (rows) => {
      await append(rows);
    },
    logs,
    refuseAppends: (reason) => {
      refusal = reason;
    },
    store,
  };
}
