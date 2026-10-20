import { MemoryStorageAdapter, type StorageAdapter } from '@brainstrike/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileExplorerStore } from '../../store';
import {
  createPersistedFileExplorerSnapshot,
  createPersistOptions,
} from '../file-explorer-persistence';
import { type StorageRequest, type WorkerResponse, WorkerStorage } from '../worker-storage';

type MessageHandler = (event: MessageEvent) => void | Promise<void>;

async function workerBoundary() {
  let receiveInWorker: MessageHandler | undefined;
  let receiveInRenderer: MessageHandler | undefined;
  const replies: WorkerResponse[] = [];
  const requests: StorageRequest[] = [];
  let holdRequests = false;
  let holdReplies = false;
  vi.stubGlobal('self', {
    addEventListener: (_type: string, handler: MessageHandler) => {
      receiveInWorker = handler;
    },
    postMessage: (data: WorkerResponse | StorageRequest) => {
      if (holdRequests && data.type === 'storage_request') {
        requests.push(data);
        return;
      }
      if (holdReplies && data.type === 'success') {
        replies.push(data);
        return;
      }
      receiveInRenderer?.(new MessageEvent('message', { data }));
    },
  });
  await import('../worker-storage.worker');
  vi.stubGlobal(
    'Worker',
    class {
      addEventListener(type: string, handler: MessageHandler) {
        if (type === 'message') {
          receiveInRenderer = handler;
        }
      }
      postMessage(data: unknown) {
        if (!receiveInWorker) {
          throw new Error('Worker protocol was not registered');
        }
        return receiveInWorker(new MessageEvent('message', { data }));
      }
      terminate() {}
    }
  );
  return {
    holdReplies: () => {
      holdReplies = true;
    },
    holdRequests: (hold: boolean) => {
      holdRequests = hold;
    },
    releaseRequest: (index: number) => {
      const request = requests[index];
      if (!request) {
        throw new Error('Controlled worker request is missing');
      }
      receiveInRenderer?.(new MessageEvent('message', { data: request }));
    },
    replies,
    requests,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('completes an adapter-acknowledged save without waiting for a final worker reply', async () => {
  vi.useFakeTimers();
  const boundary = await workerBoundary();
  boundary.holdReplies();
  const adapterAck = Promise.withResolvers<void>();
  const values = new Map<string, string>();
  const write = vi.fn(async (key: string, value: string) => {
    await adapterAck.promise;
    values.set(key, value);
  });
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: write,
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const outcome = storage.setItem('file-explorer-storage-v5', { expanded: true }).then(
    () => 'saved',
    (error: unknown) => error
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(write).toHaveBeenCalledTimes(1);
  expect(values.size).toBe(0);
  adapterAck.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(values.get('file-explorer-storage-v5')).toBe('{"expanded":true}');
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toBe('saved');
  expect(write).toHaveBeenCalledTimes(1);
  storage.destroy();
});

it('does not admit a competing write while the first adapter acknowledgment is pending', async () => {
  vi.useFakeTimers();
  await workerBoundary();
  const ack = Promise.withResolvers<void>();
  const write = vi.fn(() => ack.promise);
  const adapter: StorageAdapter = {
    clear: async () => {},
    getAllKeys: async () => [],
    getItem: async () => null,
    removeItem: async () => {},
    setItem: write,
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const outcome = storage.setItem('file-explorer-storage-v5', 'latest').catch((error) => error);
  await vi.advanceTimersByTimeAsync(5100);
  const admittedWrites = write.mock.calls.length;
  ack.resolve();
  await outcome;
  storage.destroy();
  expect(admittedWrites).toBe(1);
});

it.each(['setItem', 'removeItem'] as const)(
  'rejects an adapter %s failure instead of accepting worker success',
  async (operation) => {
    vi.useFakeTimers();
    await workerBoundary();
    const failure = new Error('Controlled adapter failure');
    const write = vi.fn(async () => {
      throw failure;
    });
    const remove = vi.fn(async () => {
      throw failure;
    });
    const adapter: StorageAdapter = {
      clear: async () => {},
      getAllKeys: async () => [],
      getItem: async () => null,
      removeItem: remove,
      setItem: write,
    };
    const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
    const completion =
      operation === 'setItem'
        ? storage.setItem('file-explorer-storage-v5', 'latest')
        : storage.removeItem('file-explorer-storage-v5');
    const outcome = completion.then(
      () => 'saved',
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe(failure);
    storage.destroy();
    expect(operation === 'setItem' ? write : remove).toHaveBeenCalledTimes(1);
  }
);

it('refuses an old timed-out worker request after a newer save commits', async () => {
  vi.useFakeTimers();
  const boundary = await workerBoundary();
  boundary.holdRequests(true);
  const values = new Map<string, string>();
  const write = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: write,
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const old = storage.setItem('settings', 'old').catch((error) => error);
  await vi.advanceTimersByTimeAsync(5100);
  expect(await old).toEqual(new Error('Worker request timeout'));
  boundary.holdRequests(false);
  const current = storage.setItem('settings', 'current');
  await vi.advanceTimersByTimeAsync(100);
  await current;
  boundary.releaseRequest(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(await adapter.getItem('settings')).toBe('current');
  expect(write).toHaveBeenCalledTimes(1);
  storage.destroy();
});

it.each(['flush', 'destroy'] as const)(
  'keeps the latest save after %s joins an older adapter write',
  async (action) => {
    vi.useFakeTimers();
    const boundary = await workerBoundary();
    const values = new Map<string, string>();
    const oldAck = Promise.withResolvers<void>();
    const adapter: StorageAdapter = {
      clear: async () => values.clear(),
      getAllKeys: async () => [...values.keys()],
      getItem: async (key) => values.get(key) ?? null,
      removeItem: async (key) => {
        values.delete(key);
      },
      setItem: async (key, value) => {
        if (value === 'old') {
          await oldAck.promise;
        }
        values.set(key, value);
      },
    };
    const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
    const old = storage.setItem('settings', 'old');
    await vi.advanceTimersByTimeAsync(100);
    boundary.holdRequests(true);
    const latest = storage.setItem('settings', 'latest');
    if (action === 'flush') {
      storage.flushPendingWrites();
    } else {
      storage.destroy();
    }
    expect(await adapter.getItem('settings')).toBeNull();
    oldAck.resolve();
    await Promise.all([old, latest]);
    expect(await adapter.getItem('settings')).toBe('latest');
    storage.destroy();
  }
);

it('a superseded debounce completion does not claim its exact snapshot was written', async () => {
  vi.useFakeTimers();
  await workerBoundary();
  const values = new Map<string, string>();
  const ack = Promise.withResolvers<void>();
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      await ack.promise;
      values.set(key, value);
    },
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const superseded = storage.setItem('settings', 'superseded');
  const latest = storage.setItem('settings', 'latest');
  expect(await adapter.getItem('settings')).toBeNull();
  await vi.advanceTimersByTimeAsync(100);
  expect(await adapter.getItem('settings')).toBeNull();
  ack.resolve();
  await Promise.all([superseded, latest]);
  expect(await adapter.getItem('settings')).toBe('latest');
  storage.destroy();
});

it('preserves a rejected adapter ACK through the Zustand persistence boundary', async () => {
  const failure = new Error('Controlled adapter failure');
  const adapter: StorageAdapter = {
    clear: async () => {},
    getAllKeys: async () => [],
    getItem: async () => null,
    removeItem: async () => {},
    setItem: async () => {
      throw failure;
    },
  };
  const options = createPersistOptions(adapter);
  if (!options.storage) {
    throw new Error('Explorer persistence storage is missing');
  }
  const store = createFileExplorerStore(new MemoryStorageAdapter());
  await expect(
    options.storage.setItem(
      'file-explorer-storage-v5',
      createPersistedFileExplorerSnapshot(store.getState())
    )
  ).rejects.toBe(failure);
});

it('keeps superseded debounce callers pending until the latest adapter ACK rejects', async () => {
  vi.useFakeTimers();
  await workerBoundary();
  const ack = Promise.withResolvers<void>();
  const adapter: StorageAdapter = {
    clear: async () => {},
    getAllKeys: async () => [],
    getItem: async () => null,
    removeItem: async () => {},
    setItem: () => ack.promise,
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  let firstSettled = false;
  const first = storage.setItem('settings', 'first').then(
    () => {
      firstSettled = true;
      return 'saved';
    },
    (error: unknown) => {
      firstSettled = true;
      return error;
    }
  );
  const latest = storage.setItem('settings', 'latest').catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  const settledBeforeAck = firstSettled;
  ack.reject(new Error('Controlled adapter failure'));
  const outcomes = await Promise.all([first, latest]);
  expect(settledBeforeAck).toBe(false);
  expect(outcomes).toEqual([
    new Error('Controlled adapter failure'),
    new Error('Controlled adapter failure'),
  ]);
  storage.destroy();
});

it('joins an admitted old save before removing Explorer persistence', async () => {
  vi.useFakeTimers();
  await workerBoundary();
  const ack = Promise.withResolvers<void>();
  const values = new Map<string, string>();
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      await ack.promise;
      values.set(key, value);
    },
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const old = storage.setItem('file-explorer-storage-v5', 'old');
  await vi.advanceTimersByTimeAsync(100);
  const { createStorageWrapper } = await import('../storage-wrapper');
  const persistence = createStorageWrapper(adapter, true, storage, false);
  let removed = false;
  const removing = persistence.removeItem('file-explorer-storage-v5').then(() => {
    removed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  const removedBeforeAck = removed;
  ack.resolve();
  await Promise.all([old, removing]);
  expect(removedBeforeAck).toBe(false);
  expect(await adapter.getItem('file-explorer-storage-v5')).toBeNull();
  storage.destroy();
});

it('does not let a queued old worker save restore a deleted key', async () => {
  vi.useFakeTimers();
  const boundary = await workerBoundary();
  boundary.holdRequests(true);
  const values = new Map<string, string>();
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  const old = storage.setItem('settings', 'old');
  await vi.advanceTimersByTimeAsync(100);
  boundary.holdRequests(false);
  await storage.removeItem('settings');
  boundary.releaseRequest(0);
  await vi.advanceTimersByTimeAsync(0);
  await old;
  expect(await adapter.getItem('settings')).toBeNull();
  storage.destroy();
});

function heldAdapterWrite(blockedValue = 'old') {
  const ack = Promise.withResolvers<void>();
  const values = new Map<string, string>();
  const adapter: StorageAdapter = {
    clear: async () => values.clear(),
    getAllKeys: async () => [...values.keys()],
    getItem: async (key) => values.get(key) ?? null,
    removeItem: async (key) => {
      values.delete(key);
    },
    setItem: async (key, value) => {
      if (value === blockedValue) {
        await ack.promise;
      }
      values.set(key, value);
    },
  };
  return { ack, adapter };
}

it.each(['flush', 'destroy'] as const)(
  '%s preserves a failed already-admitted save independently of the latest flush',
  async (action) => {
    vi.useFakeTimers();
    await workerBoundary();
    const { ack, adapter } = heldAdapterWrite();
    const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
    const old = storage.setItem('settings', 'old').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const latest = storage.setItem('settings', 'latest');
    if (action === 'flush') {
      storage.flushPendingWrites();
    } else {
      storage.destroy();
    }
    const failure = new Error('Admitted write failed');
    ack.reject(failure);
    const [outcome] = await Promise.all([old, latest]);
    expect(outcome).toBe(failure);
    expect(await adapter.getItem('settings')).toBe('latest');
    storage.destroy();
  }
);

it.each(['flush', 'destroy'] as const)(
  '%s preserves the original deadline of an admitted save',
  async (action) => {
    vi.useFakeTimers();
    await workerBoundary();
    const { ack, adapter } = heldAdapterWrite();
    const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
    let expired = false;
    const old = storage.setItem('settings', 'old').catch((error: unknown) => {
      expired = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(100);
    const latest = storage.setItem('settings', 'latest');
    if (action === 'flush') {
      storage.flushPendingWrites();
    } else {
      storage.destroy();
    }
    await vi.advanceTimersByTimeAsync(5000);
    const expiredBeforeAdapterAck = expired;
    ack.resolve();
    const [outcome] = await Promise.all([old, latest]);
    expect(expiredBeforeAdapterAck).toBe(true);
    expect(outcome).toEqual(new Error('Worker request timeout'));
    expect(await adapter.getItem('settings')).toBe('latest');
    storage.destroy();
  }
);

it('a flush preserves the deadline of a retired queued worker request', async () => {
  vi.useFakeTimers();
  const boundary = await workerBoundary();
  boundary.holdRequests(true);
  const { ack, adapter } = heldAdapterWrite('latest');
  const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
  let expired = false;
  const old = storage.setItem('settings', 'old').catch((error: unknown) => {
    expired = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(100);
  const latest = storage.setItem('settings', 'latest');
  storage.flushPendingWrites();
  await vi.advanceTimersByTimeAsync(5000);
  const expiredBeforeAdapterAck = expired;
  ack.resolve();
  const [outcome] = await Promise.all([old, latest]);
  expect(expiredBeforeAdapterAck).toBe(true);
  expect(outcome).toEqual(new Error('Worker request timeout'));
  expect(await adapter.getItem('settings')).toBe('latest');
  storage.destroy();
});

it.each(['flush', 'destroy'] as const)(
  '%s keeps an already-queued retired save pending until the latest ACK',
  async (action) => {
    vi.useFakeTimers();
    await workerBoundary();
    const oldAck = Promise.withResolvers<void>();
    const latestAck = Promise.withResolvers<void>();
    const adapter: StorageAdapter = {
      clear: async () => {},
      getAllKeys: async () => [],
      getItem: async () => null,
      removeItem: async () => {},
      setItem: async (_key, value) => {
        if (value === 'old') {
          await oldAck.promise;
        }
        if (value === 'latest') {
          await latestAck.promise;
        }
      },
    };
    const storage = new WorkerStorage(new URL('file:///controlled-worker.mjs'), adapter);
    const old = storage.setItem('settings', 'old');
    await vi.advanceTimersByTimeAsync(100);
    let queuedSettled = false;
    const queued = storage.setItem('settings', 'queued').then(() => {
      queuedSettled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    const latest = storage.setItem('settings', 'latest');
    if (action === 'flush') {
      storage.flushPendingWrites();
    } else {
      storage.destroy();
    }
    oldAck.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeLatestAck = queuedSettled;
    latestAck.resolve();
    await Promise.all([old, queued, latest]);
    expect(settledBeforeLatestAck).toBe(false);
    storage.destroy();
  }
);
