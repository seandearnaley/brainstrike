import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { ExplorerCloseLifecycleContext } from '../shell/explorer-close-lifecycle';
import { useFactoryResetWatchFence } from '../shell/use-factory-reset-watch-fence';
import { withProviderCloseOwner } from './test-helpers';

it('terminal preparation disposes the existing watch and blocks later callbacks and admissions', async () => {
  const prepare = new Set<() => Promise<void>>();
  let closing = false;
  const lifecycle = withProviderCloseOwner({
    isPreparing: () => closing,
    registerPersistence: () => () => {},
    registerProducer: (callback: () => Promise<void>) => {
      prepare.add(callback);
      return () => {
        prepare.delete(callback);
      };
    },
  });
  type Watch = Parameters<NonNullable<FileSystemAdapter['watchDirectory']>>;
  let delivered: Watch[1] | undefined;
  const dispose = vi.fn();
  const adapter = Object.assign(new MockFileSystemAdapter(), {
    watchDirectory: vi.fn((_handle: DirectoryHandle, callback: Watch[1]) => {
      delivered = callback;
      return dispose;
    }),
  });
  const { result } = renderHook(() => useFactoryResetWatchFence(adapter), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ExplorerCloseLifecycleContext.Provider value={lifecycle}>
        {children}
      </ExplorerCloseLifecycleContext.Provider>
    ),
  });
  const handle: DirectoryHandle = {
    kind: 'directory',
    name: 'fixture',
    path: '/fixture',
    platform: 'electron',
    rootId: 'root-fixture',
  };
  const callback = vi.fn();
  result.current.watchDirectory?.(handle, callback);
  closing = true;
  await act(async () => {
    await Promise.all([...prepare].map((callback) => callback()));
  });
  delivered?.([{ kind: 'file', path: 'late.ts', type: 'added' }]);
  result.current.watchDirectory?.(handle, callback);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(callback).not.toHaveBeenCalled();
  expect(adapter.watchDirectory).toHaveBeenCalledTimes(1);
});
