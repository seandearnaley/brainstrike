import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it } from 'vitest';
import { useFileContentLoadAuthority } from '../file-content-load-authority-context';
import { FileExplorerProvider } from '../shell/file-explorer-provider';
import { useSharedFileContentLoading } from '../use-shared-file-content-loading';

function createWrapper() {
  const adapter = new MockFileSystemAdapter();
  const storage = new MemoryStorageAdapter();
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        <FileExplorerProvider storageAdapter={storage}>{children}</FileExplorerProvider>
      </AdaptersProvider>
    );
  };
}

it('keeps the aggregate loader error identity stable while its error snapshot is unchanged', async () => {
  const firstKey = encodeFileSelection('root-error-memo', '/first.txt');
  const secondKey = encodeFileSelection('root-error-memo', '/second.txt');
  let releasePhysicalWork: (() => void) | undefined;
  const physicalWork = new Promise<void>((resolve) => {
    releasePhysicalWork = resolve;
  });
  const { rerender, result } = renderHook(
    () => ({
      authority: useFileContentLoadAuthority(),
      loader: useSharedFileContentLoading([]),
    }),
    { wrapper: createWrapper() }
  );
  let scheduled: Promise<void> | undefined;

  act(() => {
    scheduled = result.current.authority.scheduleBatch(
      [firstKey, secondKey],
      () => physicalWork,
      'bulk'
    );
    result.current.authority.recordErrors([
      {
        compositeKey: firstKey,
        error: new Error('first failure'),
        expectedGeneration: result.current.authority.currentGeneration(firstKey),
      },
      {
        compositeKey: secondKey,
        error: new Error('second failure'),
        expectedGeneration: result.current.authority.currentGeneration(secondKey),
      },
    ]);
  });
  await waitFor(() => expect(result.current.loader.error).toBeInstanceOf(AggregateError));
  const firstAggregate = result.current.loader.error;

  rerender();
  expect(result.current.loader.error).toBe(firstAggregate);

  await act(async () => {
    releasePhysicalWork?.();
    await scheduled;
  });
});
