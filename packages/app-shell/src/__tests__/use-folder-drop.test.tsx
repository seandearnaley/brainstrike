import { act, renderHook } from '@testing-library/react';
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
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBridgeMock.mockReturnValue({
      getDroppedPath: getDroppedPathMock,
      onOpenFolderPicker: vi.fn(),
      onOpenPath: vi.fn(),
    });
    useConnectFolderMock.mockReturnValue({ connectPath: connectPathMock, openPicker: vi.fn() });
    getDroppedPathMock.mockImplementation((file: File) => `/w/${file.name}`);
  });

  it('connects every dropped folder and toasts nothing when all resolve', () => {
    const { result } = renderHook(() => useFolderDrop());

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), directoryItem('/w/beta')]);
    });

    expect(connectPathMock).toHaveBeenCalledTimes(2);
    expect(connectPathMock).toHaveBeenNthCalledWith(1, { origin: 'drop', path: '/w/alpha' });
    expect(connectPathMock).toHaveBeenNthCalledWith(2, { origin: 'drop', path: '/w/beta' });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('mounts the folder AND toasts the skip notice for a mixed drop', () => {
    const { result } = renderHook(() => useFolderDrop());

    act(() => {
      result.current.onDropItems?.([directoryItem('/w/alpha'), plainFileItem()]);
    });

    expect(connectPathMock).toHaveBeenCalledExactlyOnceWith({ origin: 'drop', path: '/w/alpha' });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({
      title: 'Some dropped items were skipped',
    });
  });

  it('calls connectPath zero times and toasts "Nothing to connect" for an all-files drop', () => {
    const { result } = renderHook(() => useFolderDrop());

    act(() => {
      result.current.onDropItems?.([plainFileItem()]);
    });

    expect(connectPathMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ title: 'Nothing to connect' });
  });

  it('is absent when the platform has no drop bridge', () => {
    resolveBridgeMock.mockReturnValue(null);
    const { result } = renderHook(() => useFolderDrop());

    expect(result.current.onDropItems).toBeUndefined();
  });

  it('is absent when the bridge exists but connectPath does not', () => {
    useConnectFolderMock.mockReturnValue({ connectPath: undefined, openPicker: vi.fn() });
    const { result } = renderHook(() => useFolderDrop());

    expect(result.current.onDropItems).toBeUndefined();
  });
});
