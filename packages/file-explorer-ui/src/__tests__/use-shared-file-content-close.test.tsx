import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { FileContentReadResult } from '@brainstrike/workers/file-content-worker';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import type { ExplorerCloseLifecycle } from '../shell/explorer-close-lifecycle';
import { FileExplorerProvider, useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

vi.mock('@brainstrike/workers/file-content-worker', () => ({ createFileContentWorker: vi.fn() }));
function createWrapper(adapter: MockFileSystemAdapter, closeLifecycle: ExplorerCloseLifecycle) {
  const storage = new MemoryStorageAdapter();
  return ({ children }: { children: ReactNode }) => (
    <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
      <FileExplorerProvider closeLifecycle={closeLifecycle} storageAdapter={storage}>
        {children}
      </FileExplorerProvider>
    </AdaptersProvider>
  );
}

it('joins an admitted dependent reload and cancels future child admission with its exact retirement', async () => {
  const adapter = new MockFileSystemAdapter();
  const node = createFileNode({ path: '/file.txt', rootFolderId: 'root' });
  const key = encodeFileSelection('root', '/file.txt');
  const read = Promise.withResolvers<Record<string, FileContentReadResult>>();
  const worker = vi.fn(() => read.promise);
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  vi.mocked(createFileContentWorker).mockReturnValue(worker);
  const producers = new Set<() => Promise<void>>();
  let preparing = false;
  const lifecycle: ExplorerCloseLifecycle = {
    isPreparing: () => preparing,
    registerPersistence: () => () => {},
    registerProducer: (prepare) => {
      producers.add(prepare);
      return () => {
        producers.delete(prepare);
      };
    },
  };
  const view = renderHook(() => useSharedFileContentLoading([node]), {
    wrapper: createWrapper(adapter, lifecycle),
  });
  let initial!: Promise<void>;
  act(() => {
    initial = view.result.current.handleFileContentLoading([key], 'background');
  });
  await waitFor(() => expect(worker).toHaveBeenCalledOnce());
  let reload!: Promise<unknown>;
  act(() => {
    reload = view.result.current
      .reloadFileContents([key], 'background')
      .catch((error: unknown) => error);
  });
  let closed = false;
  let closing!: Promise<void>;
  act(() => {
    preparing = true;
    closing = Promise.all([...producers].map((prepare) => prepare())).then(() => {
      closed = true;
    });
  });
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(closed).toBe(false);
  } finally {
    await act(async () => {
      read.resolve({ [key]: { content: 'preceding read', status: 'accessible' } });
      await initial;
      await closing;
    });
  }
  expect(await reload).toMatchObject({ name: 'AbortError' });
  expect(worker).toHaveBeenCalledOnce();
  view.unmount();
});
it('refuses a reload after close before clearing the existing shared contents', async () => {
  const adapter = new MockFileSystemAdapter();
  const key = encodeFileSelection('root', '/cached.txt');
  const { createFileContentWorker } = await import('@brainstrike/workers/file-content-worker');
  const worker = vi.fn(async () => ({}));
  vi.mocked(createFileContentWorker).mockReturnValue(worker);
  let preparing = false;
  const producers = new Set<() => Promise<void>>();
  const lifecycle: ExplorerCloseLifecycle = {
    isPreparing: () => preparing,
    registerPersistence: () => () => {},
    registerProducer: (prepare) => {
      producers.add(prepare);
      return () => {
        producers.delete(prepare);
      };
    },
  };
  const view = renderHook(
    () => ({ loader: useSharedFileContentLoading([]), store: useFileExplorerStoreContext() }),
    { wrapper: createWrapper(adapter, lifecycle) }
  );
  await waitFor(() => expect(view.result.current.store.persist.hasHydrated()).toBe(true));
  act(() => {
    view.result.current.store.getState().setFileContent(key, 'kept through refusal');
  });
  const clear = vi.spyOn(view.result.current.store.getState(), 'clearFileContents');
  let refusal: unknown;
  await act(async () => {
    preparing = true;
    await Promise.all([...producers].map((prepare) => prepare()));
    refusal = await view.result.current.loader
      .reloadFileContents([key], 'background')
      .catch((error: unknown) => error);
  });
  expect(clear).not.toHaveBeenCalled();
  expect(view.result.current.store.getState().getFileContent(key)).toBe('kept through refusal');
  expect(worker).not.toHaveBeenCalled();
  expect(refusal).toMatchObject({ name: 'AbortError' });
  view.unmount();
});
