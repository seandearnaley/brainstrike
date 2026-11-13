/**
 * ADR-0034 build decisions: the where-control's "Turn into a project…" for a
 * thread in a scratch folder. The host asks where, moves the folder and makes
 * it a project the thread keeps working in; this window then shows the folder
 * at its new place. It waits for the thread's run to end, and a refusal is
 * said in the menu and in a toast, in the host's words.
 */
import { refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useScratchProject } from '../hooks/use-scratch-project';
import { subscribeRootRegistered } from '../roots/root-registration-events';

const { addRootByPathSpy, toastSpy } = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  toastSpy: vi.fn(),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({ addRootDirectoryByPath: addRootByPathSpy }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

const PLACE = '/Users/me/Projects/quiet-otter';
const turnScratchIntoProject =
  vi.fn<NonNullable<AssistantThreadHostCapability['turnScratchIntoProject']>>();

function withHost(host: Partial<AssistantThreadHostCapability>) {
  return ({ children }: { readonly children: ReactNode }) => (
    <AssistantThreadHostContext.Provider value={host as AssistantThreadHostCapability}>
      {children}
    </AssistantThreadHostContext.Provider>
  );
}

const inScratch = { scratch: true, threadId: 'thread-1', threadState: 'idle' } as const;

beforeEach(() => {
  addRootByPathSpy.mockReset().mockResolvedValue({ path: PLACE });
  toastSpy.mockReset();
  turnScratchIntoProject.mockReset();
});

describe('useScratchProject', () => {
  it('offers nothing for a thread that does not work in a scratch folder, or where the host cannot', () => {
    const notScratch = renderHook(() => useScratchProject({ ...inScratch, scratch: false }), {
      wrapper: withHost({ turnScratchIntoProject }),
    });
    expect(notScratch.result.current).toBeUndefined();
    const noHost = renderHook(() => useScratchProject(inScratch), { wrapper: withHost({}) });
    expect(noHost.result.current).toBeUndefined();
  });

  it("waits for the thread's run to end", () => {
    const { result } = renderHook(
      () => useScratchProject({ ...inScratch, threadState: 'running' }),
      { wrapper: withHost({ turnScratchIntoProject }) }
    );
    expect(result.current?.disabledReason).toBe("Available when this thread's run ends.");
  });

  it('asks the host for the thread, then shows the folder at its new place', async () => {
    const reread = vi.fn();
    const unsubscribe = subscribeRootRegistered(reread);
    let finish: (root: { path: string; rootId: string }) => void = () => undefined;
    turnScratchIntoProject.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { result } = renderHook(() => useScratchProject(inScratch), {
      wrapper: withHost({ turnScratchIntoProject }),
    });

    act(() => result.current?.onTurnIntoProject());
    expect(turnScratchIntoProject).toHaveBeenCalledExactlyOnceWith('thread-1');
    expect(result.current?.pending).toBe(true);
    await act(async () => {
      finish({ path: PLACE, rootId: 'r-scratch' });
    });

    await waitFor(() => expect(result.current?.pending).toBe(false));
    expect(addRootByPathSpy).toHaveBeenCalledExactlyOnceWith(PLACE);
    // The Threads panel reads the root records again, so the thread leaves Scratch.
    expect(reread).toHaveBeenCalled();
    unsubscribe();
    expect(result.current?.refusal).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('a cancelled picker changes nothing', async () => {
    turnScratchIntoProject.mockResolvedValue(null);
    const { result } = renderHook(() => useScratchProject(inScratch), {
      wrapper: withHost({ turnScratchIntoProject }),
    });

    await act(async () => {
      result.current?.onTurnIntoProject();
    });

    await waitFor(() => expect(result.current?.pending).toBe(false));
    expect(addRootByPathSpy).not.toHaveBeenCalled();
    expect(result.current?.refusal).toBeNull();
  });

  it("says why the host refused, in the menu and in a toast, in the host's words", async () => {
    turnScratchIntoProject.mockRejectedValue(
      refusalError(
        'conflict',
        'workspace.scratch-project-exists',
        `${PLACE} already exists, so the scratch folder was not moved there.`,
        'Choose another folder, or move or rename what is there.'
      )
    );
    const { result } = renderHook(() => useScratchProject(inScratch), {
      wrapper: withHost({ turnScratchIntoProject }),
    });

    await act(async () => {
      result.current?.onTurnIntoProject();
    });

    await waitFor(() =>
      expect(result.current?.refusal).toContain(
        `${PLACE} already exists, so the scratch folder was not moved there.`
      )
    );
    expect(result.current?.refusal).toContain('Choose another folder');
    expect(result.current?.pending).toBe(false);
    expect(toastSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        description: result.current?.refusal,
        title: 'Could not turn this thread into a project',
        variant: 'destructive',
      })
    );
    expect(addRootByPathSpy).not.toHaveBeenCalled();
  });
});
