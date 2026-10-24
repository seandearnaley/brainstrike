import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '../adapters/memory-storage-adapter.ts';
import {
  createWriteBehindStorageAdapter,
  createWriteBehindWriter,
} from '../write-behind-writer.ts';

function createSyncOwner() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    values,
  };
}

/** An owner that acknowledges each write only when the test says so. */
function createHeldOwner() {
  const values = new Map<string, string>();
  const acks: PromiseWithResolvers<void>[] = [];
  return {
    acks,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      const ack = Promise.withResolvers<void>();
      acks.push(ack);
      await ack.promise;
      values.set(key, value);
    }),
    values,
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

describe('createWriteBehindWriter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces writes per key and hands the owner only the latest value', async () => {
    vi.useFakeTimers();
    const owner = createSyncOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 100 });

    const first = writer.setItem('one', 'first');
    const last = writer.setItem('one', 'last');

    expect(owner.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await Promise.all([first, last]);
    expect(owner.setItem).toHaveBeenCalledTimes(1);
    expect(owner.setItem).toHaveBeenCalledWith('one', 'last');
  });

  it('writes a synchronous owner inside the flush call itself', () => {
    vi.useFakeTimers();
    const owner = createSyncOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 500 });
    void writer.setItem('one', 'pending');

    void writer.flush();

    expect(owner.values.get('one')).toBe('pending');
    vi.runAllTimers();
    expect(owner.setItem).toHaveBeenCalledTimes(1);
  });

  it('resolves flush only when the owner has acknowledged every write, the in-flight one included', async () => {
    vi.useFakeTimers();
    const owner = createHeldOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 100 });
    void writer.setItem('a', 'in-flight');
    vi.advanceTimersByTime(100);
    void writer.setItem('b', 'buffered');

    let flushed = false;
    const flushing = writer.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(owner.setItem).toHaveBeenCalledTimes(2);
    owner.acks[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);
    owner.acks[1]?.resolve();
    await flushing;
    expect(flushed).toBe(true);
    expect(Object.fromEntries(owner.values)).toEqual({ a: 'in-flight', b: 'buffered' });
  });

  it('rejects flush and the waiting caller with the failed write, never dropping it', async () => {
    const failure = new Error('owner refused the write');
    const writer = createWriteBehindWriter(
      {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => Promise.reject(failure),
      },
      { delayMs: 100 }
    );
    const saved = writer.setItem('one', 'value');

    await expect(writer.flush()).rejects.toMatchObject({ errors: [failure] });
    await expect(saved).rejects.toBe(failure);
  });

  it('drains to quiescence: a value buffered while a write is in flight reaches the owner before flush resolves', async () => {
    vi.useFakeTimers();
    const owner = createHeldOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 100 });
    void writer.setItem('one', 'first');
    vi.advanceTimersByTime(100);

    let flushed = false;
    const flushing = writer.flush().then(() => {
      flushed = true;
    });
    // A store update still runs under `inert` while the first write is pending.
    void writer.setItem('one', 'newer');
    owner.acks[0]?.resolve();
    await drainMicrotasks();

    expect(flushed).toBe(false);
    expect(owner.setItem).toHaveBeenLastCalledWith('one', 'newer');
    owner.acks[1]?.resolve();
    await flushing;
    expect(owner.values.get('one')).toBe('newer');
  });

  it('rejects flush with a timed write the owner refused before it, until a newer write of that key lands', async () => {
    vi.useFakeTimers();
    const failure = new Error('owner refused the write');
    const owner = createSyncOwner();
    owner.setItem.mockImplementationOnce(() => {
      throw failure;
    });
    const writer = createWriteBehindWriter(owner, { delayMs: 100 });
    const saved = writer.setItem('one', 'refused');
    void writer.setItem('two', 'landed');
    vi.advanceTimersByTime(100);
    // The Explorer wrapper turns this rejection into `{ success: false }`; nothing reports it.
    await expect(saved).rejects.toBe(failure);

    await expect(writer.flush()).rejects.toMatchObject({ errors: [failure] });
    // Another key landing does not clear it; a newer write of the same key does.
    void writer.setItem('two', 'landed again');
    await expect(writer.flush()).rejects.toMatchObject({ errors: [failure] });
    expect(owner.values.get('two')).toBe('landed again');
    void writer.setItem('one', 'newer');
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(owner.values.get('one')).toBe('newer');
  });

  it('clears a refused write once a removal of that key lands, and reports a refused removal', async () => {
    vi.useFakeTimers();
    const failure = new Error('owner refused the write');
    const owner = createSyncOwner();
    owner.setItem.mockImplementationOnce(() => {
      throw failure;
    });
    const writer = createWriteBehindWriter(owner, { delayMs: 100 });
    writer.setItem('one', 'refused').catch(() => undefined);
    await writer.flush().catch(() => undefined);

    await writer.removeItem('one');
    await expect(writer.flush()).resolves.toBeUndefined();

    owner.removeItem.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(writer.removeItem('one')).rejects.toBe(failure);
    await expect(writer.flush()).rejects.toMatchObject({ errors: [failure] });
  });

  it('reads a buffered value before the owner has it', async () => {
    vi.useFakeTimers();
    const owner = createSyncOwner();
    owner.values.set('one', 'stale');
    const writer = createWriteBehindWriter(owner, { delayMs: 500 });
    void writer.setItem('one', 'pending');

    expect(writer.getItem('one')).toBe('pending');
    expect(writer.getItem('two')).toBeNull();
  });

  it('cancels a buffered write on removal and settles its caller', async () => {
    vi.useFakeTimers();
    const owner = createSyncOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 500 });
    const saved = writer.setItem('one', 'pending');

    await writer.removeItem('one');
    await saved;
    vi.runAllTimers();

    expect(owner.setItem).not.toHaveBeenCalled();
    expect(owner.removeItem).toHaveBeenCalledWith('one');
  });

  it('owns no unload listener', () => {
    vi.useFakeTimers();
    const owner = createSyncOwner();
    const writer = createWriteBehindWriter(owner, { delayMs: 500 });
    void writer.setItem('one', 'pending');

    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));

    expect(owner.setItem).not.toHaveBeenCalled();
  });

  it('rejects a delay that is not a finite, non-negative number', () => {
    expect(() => createWriteBehindWriter(createSyncOwner(), { delayMs: -1 })).toThrow(RangeError);
  });
});

describe('createWriteBehindStorageAdapter', () => {
  it('keeps the asynchronous StorageAdapter shape and joins buffered writes before listing', async () => {
    const owner = new MemoryStorageAdapter();
    const adapter = createWriteBehindStorageAdapter(owner, { delayMs: 10_000 });
    void adapter.setItem('one', 'value');

    await expect(adapter.getItem('one')).resolves.toBe('value');
    await expect(owner.getItem('one')).resolves.toBeNull();
    await expect(adapter.getAllKeys()).resolves.toEqual(['one']);
    await expect(owner.getItem('one')).resolves.toBe('value');
  });
});
