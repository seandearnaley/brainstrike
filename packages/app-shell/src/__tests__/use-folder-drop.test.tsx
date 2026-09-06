import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { connectPathMock, getDroppedPathMock, resolveBridgeMock, toastMock, useConnectFolderMock } =
  vi.hoisted(() => ({
    connectPathMock: vi.fn(),
    getDroppedPathMock: vi.fn(),
    resolveBridgeMock: vi.fn(),
    toastMock: vi.fn(),
    useConnectFolderMock: vi.fn(),
  }));

vi.mock('../workspace-connect/workspace-connect-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-connect/workspace-connect-bridge')>()),
  resolveWorkspaceConnectBridge: resolveBridgeMock,
}));

vi.mock('../workspace-connect/use-connect-folder', () => ({
  useConnectFolder: useConnectFolderMock,
}));

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastMock,
}));

import { useFolderDrop } from '../workspace-connect/use-folder-drop';

function directoryItem(path: string): DataTransferItem {
  return {
    getAsFile: () => ({ name: path.split('/').at(-1) }) as unknown as File,
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: true }),
  } as unknown as DataTransferItem;
}

function plainFileItem(): DataTransferItem {
  return {
    getAsFile: () => ({ name: 'notes.md' }) as unknown as File,
    kind: 'file',
    webkitGetAsEntry: () => ({ isDirectory: false }),
  } as unknown as DataTransferItem;
}

describe('useFolderDrop', () => {
  const onRootConnectedMock = vi.fn(async () => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    resolveBridgeMock.mockReturnValue({
      getDroppedPath: getDroppedPathMock,
      onOpenFolderPicker: vi.fn(),
      onOpenPath: vi.fn(),
    });
    useConnectFolderMock.mockReturnValue({ connectPath: connectPathMock, openPicker: vi.fn() });
    getDroppedPathMock.mockImplementation((file: File) => `/w/${file.name}`);
    // Default: every connect succeeds, mirroring addRootDirectoryByPath's own
    // DirectoryHandle contract. Individual tests override to exercise refusal.
    connectPathMock.mockImplementation(
      async ({ path }: { readonly path: string }) =>
        ({ kind: 'directory', name: path.split('/').at(-1), path, platform: 'electron' }) as const
    );
  });

  function renderDrop() {
    return renderHook(() => useFolderDrop({ onRootConnected: onRootConnectedMock }));
  }

  it('connects every dropped folder in order and toasts nothing when all resolve', async () => {
    const { result } = renderDrop();

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), directoryItem('/w/beta')]);
    });

    await waitFor(() => expect(connectPathMock).toHaveBeenCalledTimes(2));
    expect(connectPathMock).toHaveBeenNthCalledWith(1, { origin: 'drop', path: '/w/alpha' });
    expect(connectPathMock).toHaveBeenNthCalledWith(2, { origin: 'drop', path: '/w/beta' });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('records a successfully connected drop as a thread secondary — the chip-parity fix', async () => {
    // The Major finding: connectPath alone mounts globally and leaves the bar
    // showing no trace of the drop. onRootConnected is the SAME chain
    // onAddFolder/onAddRecent run after their own successful mount.
    const { result } = renderDrop();

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha')]);
    });

    await waitFor(() => expect(onRootConnectedMock).toHaveBeenCalledTimes(1));
    expect(onRootConnectedMock).toHaveBeenCalledWith({
      kind: 'directory',
      name: 'alpha',
      path: '/w/alpha',
      platform: 'electron',
    });
  });

  it('records nothing when the connect is refused — the failure path stays silent, not wrong', async () => {
    connectPathMock.mockResolvedValueOnce(null);
    const { result } = renderDrop();

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), directoryItem('/w/beta')]);
    });

    // Gate on the SECOND path's connect starting, not on the first call
    // count: a mock records its call the instant it's invoked, before its
    // promise resolves, so `toHaveBeenCalledTimes(1)` would pass on the very
    // first synchronous tick — proving nothing about whether the `if
    // (handle)` branch (which would call onRootConnected) had run yet
    // (review finding). The loop is sequential, so connectPath for beta
    // cannot fire until alpha's full iteration, including that branch, has
    // settled — THAT'S the fact that proves the chain actually finished.
    await waitFor(() => expect(connectPathMock).toHaveBeenCalledTimes(2));
    // connectPath already toasted its own refusal reason for alpha; nothing
    // here should chain a second, unrelated "added but not attached" notice
    // for it — only beta, which connected, gets recorded.
    expect(onRootConnectedMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: '/w/beta' })
    );
  });

  it('a failed record does not abort the loop — the next path still connects and records', async () => {
    // THE BLOCKER: recordAddedAsSecondary throws on its first line when the
    // workspace database isn't ready yet, and the drop zone has no database
    // dependency — it renders as soon as the bridge resolves. A boot-window
    // drop must not let that throw escape and abort every path queued
    // behind the one that failed.
    const onRootConnected = vi
      .fn<(handle: { readonly name: string; readonly path: string }) => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('Cannot record a thread folder before the workspace database is ready.')
      )
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useFolderDrop({ onRootConnected }));

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), directoryItem('/w/beta')]);
    });

    // Both paths mounted (connectPath was called for both — the throw came
    // from the RECORD step, not the connect step).
    await waitFor(() => expect(connectPathMock).toHaveBeenCalledTimes(2));
    // Both paths were still handed to the record step, in order — the first
    // failure did not stop the second from being attempted.
    expect(onRootConnected).toHaveBeenCalledTimes(2);
    expect(onRootConnected).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ path: '/w/alpha' })
    );
    expect(onRootConnected).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ path: '/w/beta' })
    );
    // The user hears about the one that failed, with the SAME copy
    // recordAddedAsSecondary's own `unresolved` branch already uses.
    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        description:
          '"alpha" is still available as a workspace folder, but this thread was not updated to include it.',
        title: 'Folder added, but not attached to this thread',
      })
    );
  });

  it('connects and records one dropped folder at a time, never concurrently', async () => {
    // Review finding: firing connectPath concurrently races
    // addRootDirectoryByPath's shared loading flag and focused-root outcome.
    const order: string[] = [];
    connectPathMock.mockImplementation(async ({ path }: { readonly path: string }) => {
      order.push(`connect:${path}`);
      return {
        kind: 'directory',
        name: path.split('/').at(-1),
        path,
        platform: 'electron',
      } as const;
    });
    const recordOrder = vi.fn(async (handle: { readonly path: string }) => {
      order.push(`record:${handle.path}`);
    });
    const { result } = renderHook(() => useFolderDrop({ onRootConnected: recordOrder }));

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), directoryItem('/w/beta')]);
    });

    await waitFor(() => expect(recordOrder).toHaveBeenCalledTimes(2));
    expect(order).toEqual([
      'connect:/w/alpha',
      'record:/w/alpha',
      'connect:/w/beta',
      'record:/w/beta',
    ]);
  });

  it('mounts the folder AND toasts the skip notice for a mixed drop', async () => {
    const { result } = renderDrop();

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), plainFileItem()]);
    });

    await waitFor(() =>
      expect(connectPathMock).toHaveBeenCalledExactlyOnceWith({
        origin: 'drop',
        path: '/w/alpha',
      })
    );
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({
      title: 'Some dropped items were skipped',
    });
  });

  it('calls connectPath zero times and toasts "Nothing to connect" for an all-files drop', () => {
    const { result } = renderDrop();

    act(() => {
      result.current.onDropItems?.([plainFileItem()]);
    });

    expect(connectPathMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ title: 'Nothing to connect' });
  });

  it('is absent when the platform has no drop bridge', () => {
    resolveBridgeMock.mockReturnValue(null);
    const { result } = renderDrop();

    expect(result.current.onDropItems).toBeUndefined();
  });

  it('is absent when the bridge exists but connectPath does not', () => {
    useConnectFolderMock.mockReturnValue({ connectPath: undefined, openPicker: vi.fn() });
    const { result } = renderDrop();

    expect(result.current.onDropItems).toBeUndefined();
  });
});
