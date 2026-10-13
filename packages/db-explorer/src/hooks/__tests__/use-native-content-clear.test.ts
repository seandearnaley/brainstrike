import type { SourceFilesCapability } from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useNativeContentClear } from '../use-native-content-clear';

afterEach(() => vi.unstubAllGlobals());
const source: SourceFilesCapability = {
  chunks: async () => {
    throw new Error('Unexpected chunks');
  },
  delete: async () => {
    throw new Error('Unexpected delete');
  },
  import: async () => {
    throw new Error('Unexpected import');
  },
  list: async () => [],
  read: async () => [],
};
test('native clear uses the confirmed terminal capability without a PG provider, including chat-only content', async () => {
  const clear = vi.fn(async () => ({ deletedChunks: 0, deletedFiles: 0 }));
  vi.stubGlobal('electronAPI', { content: { clear } });
  const { result } = renderHook(() => useNativeContentClear(source, 0));
  await waitFor(() => expect(result.current.countsPending).toBe(false));
  expect(result.current.allowEmptyFiles).toBe(true);
  await act(() => result.current.onClear());
  expect(clear).toHaveBeenCalledExactlyOnceWith('CONFIRM_CLEAR_DATABASE');
  expect(result.current.error).toBeNull();
});
test('failure remains visible and never switches to an alternate deletion owner', async () => {
  const clear = vi.fn(async () => {
    throw new Error('Held current content owner');
  });
  vi.stubGlobal('electronAPI', { content: { clear } });
  const { result } = renderHook(() => useNativeContentClear(source, 0));
  await waitFor(() => expect(result.current.countsPending).toBe(false));
  await act(() => result.current.onClear());
  expect(result.current.error).toBe('Held current content owner');
  expect(clear).toHaveBeenCalledOnce();
  expect(result.current.clearing).toBe(false);
});

test('a refreshed catalog cannot display counts or failure from an older request', async () => {
  const initial = Promise.withResolvers<readonly import('@brainstrike/types').SourceFileRecord[]>();
  const refreshed =
    Promise.withResolvers<readonly import('@brainstrike/types').SourceFileRecord[]>();
  const list = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
  const capability = { ...source, list };
  const { result, rerender } = renderHook(
    ({ revision }) => useNativeContentClear(capability, revision),
    { initialProps: { revision: 0 } }
  );
  rerender({ revision: 1 });
  await act(async () => {
    initial.reject(new Error('Obsolete catalog failure'));
  });
  expect(result.current.error).toBeNull();
  expect(result.current.countsPending).toBe(true);
  await act(async () => {
    refreshed.resolve([]);
  });
  expect(result.current.countsPending).toBe(false);
  expect(result.current.recordsCount).toBe(0);
  expect(result.current.chunksCount).toBe(0);
});

test('authoritative catalog failure remains unavailable rather than fabricated empty counts', async () => {
  const capability = {
    ...source,
    list: vi.fn(async () => {
      throw new Error('Catalog unavailable');
    }),
  };
  const { result } = renderHook(() => useNativeContentClear(capability, 0));
  await waitFor(() => expect(result.current.error).toBe('Catalog unavailable'));
  expect(result.current.countsPending).toBe(true);
  expect(result.current.chunksCount).toBeNull();
});
