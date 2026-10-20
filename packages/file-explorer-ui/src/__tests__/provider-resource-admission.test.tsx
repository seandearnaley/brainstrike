import type { createFileExplorerStore } from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render, waitFor } from '@testing-library/react';
import { StrictMode, Suspense, useLayoutEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

type Store = ReturnType<typeof createFileExplorerStore>;
beforeEach(() => vi.resetModules());

async function setup() {
  const close = await import('@brainstrike/app-state/renderer-close');
  const provider = await import('../shell/file-explorer-provider');
  const lifecycle = {
    isPreparing: close.hasRendererClosePreparationStarted,
    registerOwner: close.registerRendererCloseOwner,
    registerPersistence: (prepare: () => Promise<void>, begin: () => void) =>
      close.registerRendererClosePreparation(prepare, 'persistence', begin),
    registerProducer: close.registerRendererClosePreparation,
  };
  return { ...close, ...provider, lifecycle };
}

async function write(store: Store) {
  const o = store.persist.getOptions();
  if (!(o.storage && o.name && o.partialize)) {
    throw new Error('Missing canonical persistence');
  }
  await o.storage.setItem(o.name, {
    state: o.partialize(store.getState()),
    version: o.version ?? 0,
  });
}

async function turn() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

it('close entry between render and provider commit admits no resource or child work', async () => {
  const o = await setup();
  const gate = Promise.withResolvers<void>();
  o.registerRendererClosePreparation(() => gate.promise);
  const storage = new MemoryStorageAdapter();
  const read = vi.spyOn(storage, 'getItem');
  let closing: Promise<void> | undefined;
  let childEffects = 0;
  function StartClose() {
    useLayoutEffect(() => {
      closing = o.prepareRendererClose();
    }, []);
    return null;
  }
  function Child() {
    useLayoutEffect(() => {
      childEffects += 1;
    }, []);
    return null;
  }
  const view = render(
    <>
      <StartClose />
      <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
        <Child />
      </o.FileExplorerProvider>
    </>
  );
  expect(closing).toBeDefined();
  expect(read).not.toHaveBeenCalled();
  expect(childEffects).toBe(0);
  gate.resolve();
  await closing;
  view.unmount();
});

it('a reentrant close from an admitted hydration does not publish new child producers', async () => {
  const o = await setup();
  const hydration = Promise.withResolvers<void>();
  const storage = new MemoryStorageAdapter();
  let closing: Promise<void> | undefined;
  let done = false;
  let childEffects = 0;
  vi.spyOn(storage, 'getItem').mockImplementation(async () => {
    closing = o.prepareRendererClose().then(() => {
      done = true;
    });
    await hydration.promise;
    return null;
  });
  function Child() {
    useLayoutEffect(() => {
      childEffects += 1;
    }, []);
    return null;
  }
  const view = render(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
      <Child />
    </o.FileExplorerProvider>
  );
  expect(closing).toBeDefined();
  await turn();
  expect(done).toBe(false);
  expect(childEffects).toBe(0);
  hydration.resolve();
  await closing;
  expect(done).toBe(true);
  view.unmount();
});

it('an already closing first mount starts no hydration, write, or child producer', async () => {
  const o = await setup();
  const gate = Promise.withResolvers<void>();
  o.registerRendererClosePreparation(() => gate.promise);
  const closing = o.prepareRendererClose();
  const storage = new MemoryStorageAdapter();
  const read = vi.spyOn(storage, 'getItem');
  const save = vi.spyOn(storage, 'setItem');
  let children = 0;
  function Child() {
    useLayoutEffect(() => {
      children += 1;
    }, []);
    return null;
  }
  const view = render(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
      <Child />
    </o.FileExplorerProvider>
  );
  expect({ children, reads: read.mock.calls.length, writes: save.mock.calls.length }).toEqual({
    children: 0,
    reads: 0,
    writes: 0,
  });
  gate.resolve();
  await closing;
  view.unmount();
});

it('an abandoned Suspense render acquires no resources, including when resumed after close', async () => {
  const o = await setup();
  const suspended = Promise.withResolvers<void>();
  let ready = false;
  let children = 0;
  const storage = new MemoryStorageAdapter();
  const read = vi.spyOn(storage, 'getItem');
  function Suspend() {
    if (!ready) {
      throw suspended.promise;
    }
    return null;
  }
  function Child() {
    useLayoutEffect(() => {
      children += 1;
    }, []);
    return null;
  }
  const view = render(
    <Suspense fallback={null}>
      <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
        <Child />
      </o.FileExplorerProvider>
      <Suspend />
    </Suspense>
  );
  expect(read).not.toHaveBeenCalled();
  await o.prepareRendererClose();
  await act(async () => {
    ready = true;
    suspended.resolve();
    await suspended.promise;
  });
  expect(read).not.toHaveBeenCalled();
  expect(children).toBe(0);
  view.unmount();
});

it('StrictMode replay keeps current admission and releases detached registrations after hydration', async () => {
  const o = await setup();
  const hydration = Promise.withResolvers<void>();
  const storage = new MemoryStorageAdapter();
  const read = vi.spyOn(storage, 'getItem').mockImplementation(async () => {
    await hydration.promise;
    return null;
  });
  const active = new Set<Parameters<typeof o.registerRendererCloseOwner>[0]>();
  const lifecycle = {
    ...o.lifecycle,
    registerOwner: (owner: Parameters<typeof o.registerRendererCloseOwner>[0]) => {
      active.add(owner);
      const release = o.registerRendererCloseOwner(owner);
      return () => {
        active.delete(owner);
        release();
      };
    },
  };
  const view = render(
    <StrictMode>
      <o.FileExplorerProvider closeLifecycle={lifecycle} storageAdapter={storage}>
        <span>owned</span>
      </o.FileExplorerProvider>
    </StrictMode>
  );
  expect(read).toHaveBeenCalledOnce();
  expect(active.size).toBe(2);
  await act(async () => {
    hydration.resolve();
    await hydration.promise;
  });
  await waitFor(() => expect(active.size).toBe(1));
  view.unmount();
  await waitFor(() => expect(active.size).toBe(0));
});

it('normal adapter replacement owns the new resource and retains the old physical write through close', async () => {
  const o = await setup();
  const ack = Promise.withResolvers<void>();
  const first = new MemoryStorageAdapter();
  const readFirst = vi.spyOn(first, 'getItem');
  const commit = first.setItem.bind(first);
  vi.spyOn(first, 'setItem').mockImplementation(async (name, value) => {
    await ack.promise;
    await commit(name, value);
  });
  const second = new MemoryStorageAdapter();
  const readSecond = vi.spyOn(second, 'getItem');
  let current: Store | undefined;
  function Capture() {
    current = o.useFileExplorerStoreContext();
    return null;
  }
  const view = render(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={first}>
      <Capture />
    </o.FileExplorerProvider>
  );
  if (!current) {
    throw new Error('First store absent');
  }
  const original = current;
  await act(async () => {
    await original.drainHydration();
  });
  view.rerender(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={first}>
      <Capture />
    </o.FileExplorerProvider>
  );
  expect(current).toBe(original);
  expect(readFirst).toHaveBeenCalledOnce();
  const saving = write(original);
  view.rerender(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={second}>
      <Capture />
    </o.FileExplorerProvider>
  );
  expect(current).not.toBe(original);
  expect(readSecond).toHaveBeenCalledOnce();
  let done = false;
  const closing = o.prepareRendererClose().then(() => {
    done = true;
  });
  await turn();
  expect(done).toBe(false);
  ack.resolve();
  await saving;
  await closing;
  expect(done).toBe(true);
  view.unmount();
});

it.each(['ack', 'rejection'] as const)(
  'accepted hydration can finish its canonical write during close: %s',
  async (outcome) => {
    const o = await setup();
    const hydration = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<void>();
    const otherProducer = Promise.withResolvers<void>();
    const storage = new MemoryStorageAdapter();
    vi.spyOn(storage, 'getItem').mockImplementation(async () => {
      await hydration.promise;
      return null;
    });
    const failure = new Error('original admitted hydration publication failure');
    const commit = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation(async (name, value) => {
      await ack.promise;
      await commit(name, value);
    });
    let store: Store | undefined;
    function Capture() {
      store = o.useFileExplorerStoreContext();
      return null;
    }
    const view = render(
      <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
        <Capture />
      </o.FileExplorerProvider>
    );
    if (!store) {
      throw new Error('Owned store absent');
    }
    const owned = store;
    const admitted = (async () => {
      await owned.drainHydration();
      await write(owned);
    })();
    const observed = admitted.catch((error: unknown) => error);
    o.registerRendererClosePreparation(() => admitted);
    o.registerRendererClosePreparation(() => otherProducer.promise);
    let done = false;
    const closing = o.prepareRendererClose().then(
      () => {
        done = true;
      },
      (error: unknown) => {
        done = true;
        return error;
      }
    );
    await turn();
    expect(done).toBe(false);
    hydration.resolve();
    await turn();
    expect(storage.setItem).toHaveBeenCalled();
    expect(done).toBe(false);
    if (outcome === 'rejection') {
      ack.reject(failure);
    } else {
      ack.resolve();
    }
    expect(await observed).toBe(outcome === 'rejection' ? failure : undefined);
    expect(done).toBe(false);
    otherProducer.resolve();
    const result = await closing;
    if (outcome === 'rejection') {
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toContain(failure);
    } else {
      expect(result).toBeUndefined();
    }
    view.unmount();
  }
);
