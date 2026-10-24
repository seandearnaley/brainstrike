import type { StorageAdapter } from './types.ts';

/**
 * The owner a write-behind writer hands each key's latest value to. It must apply and settle
 * writes in invocation order: `localStorage` does, and Main's storage adapter serializes them
 * under its lock. A synchronous owner is written synchronously, so a `flush()` from `pagehide`
 * still lands.
 */
export interface WriteBehindAdapter {
  getItem: (key: string) => string | null | Promise<string | null>;
  removeItem: (key: string) => void | Promise<void>;
  setItem: (key: string, value: string) => void | Promise<void>;
}

export interface WriteBehindWriter {
  /**
   * Writes every buffered key now, and any key buffered while it waits, and resolves once
   * nothing is buffered or in flight. Rejects with each key whose newest write the owner
   * refused: that failure stands until a newer write of the key lands. Nothing is retried.
   */
  flush: () => Promise<void>;
  /** Read-after-write: a buffered value wins over the owner's copy. */
  getItem: (key: string) => string | null | Promise<string | null>;
  /** Cancels the key's buffered write, then removes it from the owner. */
  removeItem: (key: string) => Promise<void>;
  /**
   * Buffers `value` for `delayMs`; a later value for the same key replaces it. Resolves once the
   * owner acknowledged the write that carried this value or a later one, and rejects with it.
   */
  setItem: (key: string, value: string) => Promise<void>;
}

export interface WriteBehindWriterOptions {
  readonly delayMs: number;
}

interface BufferedWrite {
  readonly settled: PromiseWithResolvers<void>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly value: string;
}

/**
 * The one renderer write-behind writer (ADR-0026 R1). Every durable renderer write with a
 * write-behind tail goes through it, and each document unload joins its `flush()` (see
 * `@brainstrike/app-state/renderer-close`). It owns no unload listener: who flushes, and when,
 * belongs to the document's lifecycle owner.
 */
export function createWriteBehindWriter(
  adapter: WriteBehindAdapter,
  options: WriteBehindWriterOptions
): WriteBehindWriter {
  if (!(Number.isFinite(options.delayMs) && options.delayMs >= 0)) {
    throw new RangeError('delayMs must be a finite, non-negative number');
  }
  const buffered = new Map<string, BufferedWrite>();
  const inFlight = new Set<Promise<void>>();
  /** Per key, the refusal of its newest write; writes settle in order, so the last one decides. */
  const refused = new Map<string, unknown>();

  const send = (key: string, start: () => void | Promise<void>): Promise<void> => {
    let sent: Promise<void>;
    try {
      sent = Promise.resolve(start());
    } catch (error) {
      sent = Promise.reject(error);
    }
    inFlight.add(sent);
    sent.then(
      () => {
        inFlight.delete(sent);
        refused.delete(key);
      },
      (error: unknown) => {
        inFlight.delete(sent);
        refused.set(key, error);
      }
    );
    return sent;
  };

  const write = (key: string): void => {
    const entry = buffered.get(key);
    if (!entry) {
      return;
    }
    buffered.delete(key);
    clearTimeout(entry.timer);
    send(key, () => adapter.setItem(key, entry.value)).then(
      entry.settled.resolve,
      entry.settled.reject
    );
  };

  return {
    flush: async () => {
      // Until quiescent: a value buffered while earlier writes were in flight goes out too.
      while (buffered.size > 0 || inFlight.size > 0) {
        for (const key of [...buffered.keys()]) {
          write(key);
        }
        await Promise.allSettled([...inFlight]);
      }
      if (refused.size > 0) {
        throw new AggregateError(
          [...refused.values()],
          'Write-behind writes failed to reach their owner'
        );
      }
    },
    getItem: (key) => {
      const entry = buffered.get(key);
      return entry ? entry.value : adapter.getItem(key);
    },
    removeItem: async (key) => {
      const entry = buffered.get(key);
      if (entry) {
        buffered.delete(key);
        clearTimeout(entry.timer);
        // Removal is the key's latest value: callers waiting on the buffered write are done.
        entry.settled.resolve();
      }
      await send(key, () => adapter.removeItem(key));
    },
    setItem: (key, value) => {
      const previous = buffered.get(key);
      if (previous) {
        clearTimeout(previous.timer);
      }
      const settled = previous?.settled ?? Promise.withResolvers<void>();
      buffered.set(key, {
        settled,
        timer: setTimeout(() => write(key), options.delayMs),
        value,
      });
      return settled.promise;
    },
  };
}

/** {@link createWriteBehindWriter} over an asynchronous `StorageAdapter`, keeping its shape. */
export function createWriteBehindStorageAdapter(
  adapter: StorageAdapter,
  options: WriteBehindWriterOptions
): StorageAdapter & Pick<WriteBehindWriter, 'flush'> {
  const writer = createWriteBehindWriter(adapter, options);
  return {
    // Whole-store operations see every buffered write first.
    clear: async () => {
      await writer.flush();
      await adapter.clear();
    },
    flush: writer.flush,
    getAllKeys: async () => {
      await writer.flush();
      return await adapter.getAllKeys();
    },
    getItem: async (key) => await writer.getItem(key),
    removeItem: writer.removeItem,
    setItem: writer.setItem,
  };
}
