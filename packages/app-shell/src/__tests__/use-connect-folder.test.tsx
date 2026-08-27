import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addRootDirectoryByPathMock,
  addRootDirectoryMock,
  fileSystemAccessSupportedRef,
  pickerlessCapabilityRef,
  toastMock,
} = vi.hoisted(() => ({
  addRootDirectoryByPathMock: vi.fn(),
  addRootDirectoryMock: vi.fn(),
  fileSystemAccessSupportedRef: { current: true },
  pickerlessCapabilityRef: { current: true },
  toastMock: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: addRootDirectoryMock,
    addRootDirectoryByPath: pickerlessCapabilityRef.current
      ? addRootDirectoryByPathMock
      : undefined,
    isFileSystemAccessSupported: () => ({
      reason: fileSystemAccessSupportedRef.current
        ? ''
        : 'File system access not supported in this environment',
      supported: fileSystemAccessSupportedRef.current,
    }),
  }),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastMock,
}));

import { useConnectFolder } from '../workspace-connect/use-connect-folder';

describe('useConnectFolder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemAccessSupportedRef.current = true;
    pickerlessCapabilityRef.current = true;
    addRootDirectoryMock.mockResolvedValue(null);
  });

  it('mounts a granted path through the picker-less seam', async () => {
    addRootDirectoryByPathMock.mockResolvedValue({ name: 'brainstrike', path: '/w/bs' });
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'argv', path: '/w/bs' });
    });

    expect(addRootDirectoryByPathMock).toHaveBeenCalledExactlyOnceWith('/w/bs');
    expect(addRootDirectoryMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('REFUSES a never-granted path and offers the picker as the remedy', async () => {
    // The core of ruling S1: no silent grant, and the remedy is one click.
    addRootDirectoryByPathMock.mockRejectedValue(
      new Error('Folder was never granted in this app; use Add Folder to grant it.')
    );
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'open-file', path: '/w/new' });
    });

    expect(addRootDirectoryMock).not.toHaveBeenCalled();
    const [call] = toastMock.mock.calls;
    expect(call?.[0]).toMatchObject({
      persistent: true,
      title: 'BrainStrike has not been granted access to this folder',
      variant: 'destructive',
    });
    expect(String(call?.[0]?.description)).toContain('/w/new');
    expect(call?.[0]?.action).toBeDefined();
  });

  it('matches the never-granted refusal even through the ipcRenderer.invoke envelope', async () => {
    // Real Electron wraps a main-process rejection's message exactly like
    // this before it reaches the renderer — a review finding: the exact-string
    // match never fired in production because it was only tested un-enveloped.
    addRootDirectoryByPathMock.mockRejectedValue(
      new Error(
        "Error invoking remote method 'fs:addRootByPath': Error: Folder was never granted in this app; use Add Folder to grant it."
      )
    );
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'argv', path: '/w/enveloped' });
    });

    const [call] = toastMock.mock.calls;
    expect(call?.[0]).toMatchObject({
      persistent: true,
      title: 'BrainStrike has not been granted access to this folder',
      variant: 'destructive',
    });
    expect(call?.[0]?.action).toBeDefined();
  });

  it('matches the managed-but-unauthorized refusal on the same remedy', async () => {
    addRootDirectoryByPathMock.mockRejectedValue(
      new Error(
        'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.'
      )
    );
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'argv', path: '/w/wt' });
    });

    expect(toastMock.mock.calls[0]?.[0]?.action).toBeDefined();
  });

  it('does NOT offer the grant remedy for a missing folder', async () => {
    // [D9]'s "Folder not found" half: a recents path whose folder is gone is
    // not a grant problem, and offering "Add folder…" would misdescribe it.
    addRootDirectoryByPathMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'menu-recent', path: '/w/gone' });
    });

    const [call] = toastMock.mock.calls;
    expect(call?.[0]?.action).toBeUndefined();
    expect(String(call?.[0]?.description)).toContain('ENOENT');
  });

  it('reports a null handle rather than pretending the folder connected', async () => {
    addRootDirectoryByPathMock.mockResolvedValue(null);
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.connectPath?.({ origin: 'argv', path: '/w/bs' });
    });

    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it('is ABSENT when the platform has no picker-less capability', () => {
    // Web: `addRootDirectoryByPath` is undefined. `connectPath` must not exist
    // rather than exist-and-no-op.
    pickerlessCapabilityRef.current = false;
    const { result } = renderHook(() => useConnectFolder());

    expect(result.current.connectPath).toBeUndefined();
  });

  it('openPicker runs the ordinary Add Folder flow and toasts its failure', async () => {
    addRootDirectoryMock.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useConnectFolder());

    await act(async () => {
      await result.current.openPicker?.();
    });

    expect(addRootDirectoryMock).toHaveBeenCalledTimes(1);
    expect(addRootDirectoryByPathMock).not.toHaveBeenCalled();
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'destructive' });
  });

  it('is ABSENT when the platform has no File System Access capability', () => {
    // Firefox/Safari: no showDirectoryPicker, no adapter requestDirectoryAccess.
    // openPicker must not exist rather than exist-and-always-throw (the ⌘K
    // "Open folder…" command's isAvailable gates on this presence).
    fileSystemAccessSupportedRef.current = false;
    const { result } = renderHook(() => useConnectFolder());

    expect(result.current.openPicker).toBeUndefined();
  });
});
