import type { createFileExplorerStore } from '@brainstrike/file-explorer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

type Store = ReturnType<typeof createFileExplorerStore>;
beforeEach(() => vi.resetModules());

async function owners() {
  const close = await import('@brainstrike/app-state/renderer-close');
  const provider = await import('../shell/file-explorer-provider');
  return {
    ...close,
    ...provider,
    lifecycle: {
      isPreparing: close.hasRendererClosePreparationStarted,
      registerOwner: close.registerRendererCloseOwner,
      registerPersistence: (prepare: () => Promise<void>, begin: () => void) =>
        close.registerRendererClosePreparation(prepare, 'persistence', begin),
      registerProducer: close.registerRendererClosePreparation,
    },
  };
}

async function admitWrite(store: Store): Promise<void> {
  const options = store.persist.getOptions();
  if (!(options.name && options.storage && options.partialize)) {
    throw new Error('The real Explorer persistence boundary is unavailable');
  }
  await options.storage.setItem(options.name, {
    state: options.partialize(store.getState()),
    version: options.version ?? 0,
  });
}

async function flushCloseTurn() {
  await act(async () => {
    // A full event-loop turn drains close's Promise.allSettled reactions;
    // the physical ACK gates remain unresolved until the test releases them.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

it('late producer registration must not throw after render admitted hydration', async () => {
  const o = await owners();
  const hydration = Promise.withResolvers<void>();
  const holdClose = Promise.withResolvers<void>();
  const storage = new MemoryStorageAdapter();
  const read = vi.spyOn(storage, 'getItem').mockImplementation(async () => {
    await hydration.promise;
    return null;
  });
  o.registerRendererClosePreparation(() => holdClose.promise);
  let closing: Promise<void> | undefined;
  let closed = false;
  let closedBeforeHydration = false;
  let mounted: ReturnType<typeof render> | undefined;
  let thrown: unknown;
  function StartClose() {
    useLayoutEffect(() => {
      closing = o.prepareRendererClose().then(() => {
        closed = true;
      });
    }, []);
    return null;
  }
  try {
    try {
      mounted = render(
        <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
          <StartClose />
        </o.FileExplorerProvider>
      );
    } catch (error) {
      thrown = error;
    }
    expect(read).toHaveBeenCalledOnce();
    holdClose.resolve();
    await flushCloseTurn();
    closedBeforeHydration = closed;
  } finally {
    hydration.resolve();
    holdClose.resolve();
    await closing;
    mounted?.unmount();
  }
  expect({ closedBeforeHydration, thrown }).toEqual({
    closedBeforeHydration: false,
    thrown: undefined,
  });
});

it('a close between both registrations must retain an admitted write until its ACK', async () => {
  const o = await owners();
  const hydration = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  const storage = new MemoryStorageAdapter();
  vi.spyOn(storage, 'getItem').mockImplementation(async () => {
    await hydration.promise;
    return null;
  });
  const original = storage.setItem.bind(storage);
  vi.spyOn(storage, 'setItem').mockImplementation(async (name, value) => {
    await ack.promise;
    await original(name, value);
  });
  let closing: Promise<void> | undefined;
  let closed = false;
  let saving: Promise<void> | undefined;
  let mounted: ReturnType<typeof render> | undefined;
  let thrown: unknown;
  const lifecycle = o.lifecycle;
  function AcceptedWrite() {
    const store = o.useFileExplorerStoreContext();
    useLayoutEffect(() => {
      saving = admitWrite(store);
      closing = o.prepareRendererClose().then(() => {
        closed = true;
      });
    }, [store]);
    return null;
  }
  let closedBeforeAck = false;
  try {
    try {
      mounted = render(
        <o.FileExplorerProvider closeLifecycle={lifecycle} storageAdapter={storage}>
          <AcceptedWrite />
        </o.FileExplorerProvider>
      );
    } catch (error) {
      thrown = error;
    }
    hydration.resolve();
    await flushCloseTurn();
    expect(closing).toBeDefined();
    closedBeforeAck = closed;
  } finally {
    hydration.resolve();
    ack.resolve();
    await saving;
    await closing;
    mounted?.unmount();
  }
  expect({ closedBeforeAck, thrown }).toEqual({ closedBeforeAck: false, thrown: undefined });
});

it('adapter replacement during close must neither admit a new hydration nor discard the old write', async () => {
  const o = await owners();
  const holdClose = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  o.registerRendererClosePreparation(() => holdClose.promise);
  const originalStorage = new MemoryStorageAdapter();
  const originalWrite = originalStorage.setItem.bind(originalStorage);
  vi.spyOn(originalStorage, 'setItem').mockImplementation(async (name, value) => {
    await ack.promise;
    await originalWrite(name, value);
  });
  const replacement = new MemoryStorageAdapter();
  const replacementRead = vi.spyOn(replacement, 'getItem');
  let currentStore: Store | undefined;
  function ReadStore() {
    currentStore = o.useFileExplorerStoreContext();
    return null;
  }
  const view = render(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={originalStorage}>
      <ReadStore />
    </o.FileExplorerProvider>
  );
  if (!currentStore) {
    throw new Error('No actual Explorer store mounted');
  }
  const admittedStore = currentStore;
  await act(async () => {
    await admittedStore.drainHydration();
  });
  const saving = admitWrite(admittedStore);
  let closed = false;
  const closing = o.prepareRendererClose().then(() => {
    closed = true;
  });
  let thrown: unknown;
  let closedBeforeAck = false;
  let lateNewStoreWriteAccepted = false;
  try {
    try {
      view.rerender(
        <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={replacement}>
          <ReadStore />
        </o.FileExplorerProvider>
      );
    } catch (error) {
      thrown = error;
    }
    if (currentStore && currentStore !== admittedStore) {
      lateNewStoreWriteAccepted = await admitWrite(currentStore).then(
        () => true,
        () => false
      );
    }
    holdClose.resolve();
    await flushCloseTurn();
    closedBeforeAck = closed;
  } finally {
    holdClose.resolve();
    ack.resolve();
    await saving;
    await closing;
    view.unmount();
  }
  expect({
    closedBeforeAck,
    lateNewStoreWriteAccepted,
    replacementHydrations: replacementRead.mock.calls.length,
    thrown,
  }).toEqual({
    closedBeforeAck: false,
    lateNewStoreWriteAccepted: false,
    replacementHydrations: 0,
    thrown: undefined,
  });
});

it('same-store re-registration during close must keep the earlier owner through ACK without throwing', async () => {
  const o = await owners();
  const holdClose = Promise.withResolvers<void>();
  const ack = Promise.withResolvers<void>();
  o.registerRendererClosePreparation(() => holdClose.promise);
  const storage = new MemoryStorageAdapter();
  const originalWrite = storage.setItem.bind(storage);
  vi.spyOn(storage, 'setItem').mockImplementation(async (name, value) => {
    await ack.promise;
    await originalWrite(name, value);
  });
  let store: Store | undefined;
  function ReadStore() {
    store = o.useFileExplorerStoreContext();
    return null;
  }
  const view = render(
    <o.FileExplorerProvider closeLifecycle={o.lifecycle} storageAdapter={storage}>
      <ReadStore />
    </o.FileExplorerProvider>
  );
  if (!store) {
    throw new Error('No actual Explorer store mounted');
  }
  const original = store;
  await act(async () => {
    await original.drainHydration();
  });
  const saving = admitWrite(original);
  let closed = false;
  const closing = o.prepareRendererClose().then(() => {
    closed = true;
  });
  let thrown: unknown;
  let closedBeforeAck = false;
  try {
    try {
      view.rerender(
        <o.FileExplorerProvider closeLifecycle={{ ...o.lifecycle }} storageAdapter={storage}>
          <ReadStore />
        </o.FileExplorerProvider>
      );
    } catch (error) {
      thrown = error;
    }
    holdClose.resolve();
    await flushCloseTurn();
    closedBeforeAck = closed;
  } finally {
    holdClose.resolve();
    ack.resolve();
    await saving;
    await closing;
    view.unmount();
  }
  expect({ closedBeforeAck, sameStore: store === original, thrown }).toEqual({
    closedBeforeAck: false,
    sameStore: true,
    thrown: undefined,
  });
});
