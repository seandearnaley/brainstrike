/**
 * ADR-0034 build decisions (BST-2513): the where-control's "New project folder…" for a thread
 * that works with no folder of its own. The host asks where with the folder picker, makes the
 * folder there, opens it as a project and binds the thread to it; this window then shows the
 * folder. It is offered only for a sent thread whose binding names no folder (a scratch thread's
 * names its scratch folder), it waits for the thread's run to end, and a refusal is said in the
 * menu and in a toast, in the host's words.
 */
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { newThreadId } from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useNewProjectFolder } from '../hooks/use-new-project-folder';
import { subscribeRootRegistered } from '../roots/root-registration-events';

const { addRootByPathSpy, toastSpy } = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootByPathSpy }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

const PLACE = '/Users/me/Projects/release-notes';
const newProjectFolder = vi.fn<NonNullable<AssistantThreadHostCapability['newProjectFolder']>>();

function withHost(host: Partial<AssistantThreadHostCapability>) {
  return ({ children }: { readonly children: ReactNode }) => (
    <AssistantThreadHostContext.Provider value={host as AssistantThreadHostCapability}>
      {children}
    </AssistantThreadHostContext.Provider>
  );
}

/** A sent thread whose binding names no folder. */
const folderless = {
  boundRootId: undefined,
  metadataPending: false,
  resourceId: 'workspace-a',
  threadId: 'thread-1',
  threadState: 'idle',
} as const;

beforeEach(() => {
  addRootByPathSpy.mockReset().mockResolvedValue({ path: PLACE });
  toastSpy.mockReset();
  newProjectFolder.mockReset();
});

describe('useNewProjectFolder', () => {
  it('is offered for a sent thread with no folder of its own', () => {
    const { result } = renderHook(() => useNewProjectFolder(folderless), {
      wrapper: withHost({ newProjectFolder }),
    });
    expect(result.current).toEqual(
      expect.objectContaining({ disabledReason: null, pending: false, refusal: null })
    );
  });

  it.each([
    ['a thread bound to a folder', { boundRootId: 'r-alpha' }],
    // A scratch thread is bound to the folder the host made for it.
    ['a scratch thread', { boundRootId: 'r-scratch' }],
    ['a thread whose folders have not loaded', { metadataPending: true }],
    ['the new thread, not sent yet', { threadId: newThreadId('workspace-a') }],
    ['no thread', { threadId: undefined }],
  ])('is not offered for %s', (_name, overrides) => {
    const { result } = renderHook(() => useNewProjectFolder({ ...folderless, ...overrides }), {
      wrapper: withHost({ newProjectFolder }),
    });
    expect(result.current).toBeUndefined();
  });

  it('is not offered where the host makes no folders', () => {
    const { result } = renderHook(() => useNewProjectFolder(folderless), {
      wrapper: withHost({}),
    });
    expect(result.current).toBeUndefined();
  });

  it("waits for the thread's run to end", () => {
    const { result } = renderHook(
      () => useNewProjectFolder({ ...folderless, threadState: 'running' }),
      { wrapper: withHost({ newProjectFolder }) }
    );
    expect(result.current?.disabledReason).toBe("Available when this thread's run ends.");
  });

  it('asks the host for the thread, then shows the new folder in this window', async () => {
    const reread = vi.fn();
    const unsubscribe = subscribeRootRegistered(reread);
    let finish: (root: { path: string; rootId: string }) => void = () => undefined;
    newProjectFolder.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() => useNewProjectFolder(folderless), {
      wrapper: withHost({ newProjectFolder }),
    });

    act(() => result.current?.onNewProjectFolder());
    expect(newProjectFolder).toHaveBeenCalledExactlyOnceWith('thread-1');
    expect(result.current?.pending).toBe(true);
    await act(async () => {
      finish({ path: PLACE, rootId: 'r-new' });
    });

    await waitFor(() => expect(result.current?.pending).toBe(false));
    expect(addRootByPathSpy).toHaveBeenCalledExactlyOnceWith(PLACE);
    // The Threads panel reads the root records again, so the thread lists under its project.
    expect(reread).toHaveBeenCalled();
    unsubscribe();
    expect(result.current?.refusal).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a cancelled picker changes nothing', async () => {
    newProjectFolder.mockResolvedValue(null);
    const { result } = renderHook(() => useNewProjectFolder(folderless), {
      wrapper: withHost({ newProjectFolder }),
    });

    await act(async () => {
      result.current?.onNewProjectFolder();
    });

    await waitFor(() => expect(result.current?.pending).toBe(false));
    expect(addRootByPathSpy).not.toHaveBeenCalled();
    expect(result.current?.refusal).toBeNull();
  });

  it("says why the host refused, in the menu and in a toast, in the host's words", async () => {
    newProjectFolder.mockRejectedValue(
      refusalError(
        'conflict',
        'workspace.folder-exists',
        `${PLACE} already exists, so no project folder was made there.`,
        'Choose another folder, or move or rename what is there.'
      )
    );
    const { result } = renderHook(() => useNewProjectFolder(folderless), {
      wrapper: withHost({ newProjectFolder }),
    });

    await act(async () => {
      result.current?.onNewProjectFolder();
    });

    await waitFor(() =>
      expect(result.current?.refusal).toContain(
        `${PLACE} already exists, so no project folder was made there.`
      )
    );
    expect(result.current?.refusal).toContain('Choose another folder');
    expect(result.current?.pending).toBe(false);
    expect(toastSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        description: result.current?.refusal,
        title: 'Could not make a new project folder',
        variant: 'destructive',
      })
    );
    expect(addRootByPathSpy).not.toHaveBeenCalled();
  });

  it("never shows another thread's refusal", async () => {
    newProjectFolder.mockRejectedValue(
      refusalError('conflict', 'workspace.folder-exists', 'Taken.')
    );
    const { rerender, result } = renderHook(
      ({ threadId }: { readonly threadId: string }) =>
        useNewProjectFolder({ ...folderless, threadId }),
      { initialProps: { threadId: 'thread-1' }, wrapper: withHost({ newProjectFolder }) }
    );
    await act(async () => {
      result.current?.onNewProjectFolder();
    });
    await waitFor(() => expect(result.current?.refusal).toContain('Taken.'));

    rerender({ threadId: 'thread-2' });
    expect(result.current?.refusal).toBeNull();
  });
});
