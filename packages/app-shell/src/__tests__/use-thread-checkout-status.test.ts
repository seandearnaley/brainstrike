import { createFileExplorerRefreshEvent } from '@brainstrike/file-explorer-ui/shell';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useThreadCheckoutStatus } from '../hooks/use-thread-checkout-status';

// The two id spaces the chip straddles, deliberately DIFFERENT: `window.git`
// speaks the durable `roots.id`, while the FILE_EXPLORER_REFRESH_EVENT mapping
// in use-changes-live-refresh keys registrations on the file-explorer ADAPTER
// rootId. They coincide for reconciled-insert roots and diverge for legacy
// path-matched ones — a fixture that used one value could not tell them apart.
const ADAPTER_ROOT_ID = 'adapter-a';
const DB_ROOT_ID = 'db-a';

const status = vi.fn();

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

beforeEach(() => {
  loggerMock.warn.mockClear();
  useChangesLiveRefreshStore.getState().reset();
  (window as Window & { git?: unknown }).git = {
    aheadBehind: vi.fn(),
    commit: vi.fn(),
    commitFiles: vi.fn(),
    createBranch: vi.fn(),
    diff: vi.fn(),
    fetch: vi.fn(),
    history: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    repository: vi.fn(),
    stage: vi.fn(),
    status,
    structuredFileDiff: vi.fn(),
    switchBranch: vi.fn(),
    unstage: vi.fn(),
  };
});

afterEach(() => {
  (window as Window & { git?: unknown }).git = undefined;
  status.mockReset();
});

describe('useThreadCheckoutStatus', () => {
  it('maps git status to the bar checkout and refetches on an invalidation event', async () => {
    status.mockResolvedValueOnce({
      ok: true,
      value: {
        ahead: 2,
        behind: 0,
        branch: 'main',
        clean: true,
        files: [],
        isRepository: true,
        upstream: 'origin/main',
      },
    });
    const { result } = renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        checkout: { ahead: 2, behind: 0, branch: 'main', dirty: false },
        settled: true,
      })
    );

    status.mockResolvedValueOnce({
      ok: true,
      value: {
        ahead: null,
        behind: null,
        branch: null,
        clean: false,
        files: [{ path: 'a', staged: false, status: 'M', unstaged: true, untracked: false }],
        isRepository: true,
        upstream: null,
      },
    });
    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/ws/a/.git',
        repositoryRoot: '/ws/a',
      });
    });
    await waitFor(() =>
      expect(result.current).toEqual({
        checkout: { ahead: null, behind: null, branch: null, dirty: true },
        settled: true,
      })
    );
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('refetches on a WORKING-TREE refresh for its own repository, and not for another', async () => {
    const cleanStatus = {
      ok: true,
      value: {
        ahead: 0,
        behind: 0,
        branch: 'main',
        clean: true,
        files: [],
        isRepository: true,
        upstream: null,
      },
    };
    status.mockResolvedValue(cleanStatus);
    const { result } = renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    await waitFor(() => expect(result.current.checkout?.dirty).toBe(false));
    expect(result.current.settled).toBe(true);
    expect(status).toHaveBeenCalledTimes(1);

    // A working-tree edit under ANOTHER repository must not churn this chip.
    act(() => {
      useChangesLiveRefreshStore.getState().ingestWorkingTreeRefresh(['/ws/other']);
    });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    // Its own repository's working tree changed: the dirty dot must follow,
    // even though no git-METADATA push accompanied the edit.
    status.mockResolvedValue({
      ok: true,
      value: {
        ...cleanStatus.value,
        clean: false,
        files: [{ path: 'a', staged: false, status: 'M', unstaged: true, untracked: false }],
      },
    });
    act(() => {
      useChangesLiveRefreshStore.getState().ingestWorkingTreeRefresh(['/ws/a']);
    });
    await waitFor(() => expect(result.current.checkout?.dirty).toBe(true));
    expect(status).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for a non-repository, a null root, and when the bridge is absent', async () => {
    status.mockResolvedValueOnce({
      ok: true,
      value: {
        ahead: null,
        behind: null,
        branch: null,
        clean: true,
        files: [],
        isRepository: false,
        upstream: null,
      },
    });
    const { result } = renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current.checkout).toBeUndefined();
    // Confirmed non-repository IS a settled outcome, not a perpetual pending —
    // this is the exact case BST-1400's `data-checkout-state` needed to
    // distinguish from "still loading".
    await waitFor(() => expect(result.current.settled).toBe(true));

    // No root at all: nothing to await, so settled immediately.
    const { result: nullRoot } = renderHook(() => useThreadCheckoutStatus(null));
    expect(nullRoot.current).toEqual({ checkout: undefined, settled: true });

    (window as Window & { git?: unknown }).git = undefined;
    const { result: noBridge } = renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    // No bridge: also nothing to await.
    expect(noBridge.current).toEqual({ checkout: undefined, settled: true });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed status as undefined and logs — never a fake clean state', async () => {
    status.mockResolvedValueOnce({ error: 'boom', ok: false });
    const { result } = renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current.checkout).toBeUndefined();
    // A failed round-trip still SETTLES — the caller must not wait forever.
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'git status for the workspace bar failed',
      expect.objectContaining({ dbRootId: DB_ROOT_ID, error: 'boom' })
    );
  });

  it('asks git with the DB root id but registers the working-tree scope under the ADAPTER id', async () => {
    const cleanStatus = {
      ok: true,
      value: {
        ahead: 0,
        behind: 0,
        branch: 'main',
        clean: true,
        files: [],
        isRepository: true,
        upstream: null,
      },
    };
    status.mockResolvedValue(cleanStatus);
    renderHook(() =>
      useThreadCheckoutStatus({
        adapterRootId: ADAPTER_ROOT_ID,
        dbRootId: DB_ROOT_ID,
        path: '/ws/a',
      })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    // The bridge speaks the DB id space, and only that one.
    expect(status).toHaveBeenCalledWith(DB_ROOT_ID);
    expect(status).not.toHaveBeenCalledWith(ADAPTER_ROOT_ID);

    // A working-tree batch announced under the DB id matches no registration:
    // the canonical pipeline names roots by their ADAPTER id.
    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: 'src/a.ts', type: 'modified' }],
              rootId: DB_ROOT_ID,
              rootPath: '/ws/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    // Announced under the adapter id it DOES match, so the dirty dot follows.
    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: 'src/a.ts', type: 'modified' }],
              rootId: ADAPTER_ROOT_ID,
              rootPath: '/ws/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('registers nothing when the primary root is not mounted, but still tracks metadata pushes', async () => {
    const cleanStatus = {
      ok: true,
      value: {
        ahead: 0,
        behind: 0,
        branch: 'main',
        clean: true,
        files: [],
        isRepository: true,
        upstream: null,
      },
    };
    status.mockResolvedValue(cleanStatus);
    renderHook(() =>
      useThreadCheckoutStatus({ adapterRootId: null, dbRootId: DB_ROOT_ID, path: '/ws/a' })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    // No registration: a working-tree batch cannot be mapped to this root.
    act(() => {
      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: [
            {
              changes: [{ kind: 'file', path: 'src/a.ts', type: 'modified' }],
              rootId: ADAPTER_ROOT_ID,
              rootPath: '/ws/a',
            },
          ],
          scope: 'incremental',
          source: 'watcher',
        })
      );
    });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));

    // The shared owner is still held, so git-METADATA pushes still refetch.
    act(() => {
      useChangesLiveRefreshStore.getState().ingestInvalidation({
        generation: 1,
        gitCommonDir: '/ws/a/.git',
        repositoryRoot: '/ws/a',
      });
    });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('never renders one root checkout under another root', async () => {
    status.mockResolvedValueOnce({
      ok: true,
      value: {
        ahead: 3,
        behind: 0,
        branch: 'root-a-branch',
        clean: true,
        files: [],
        isRepository: true,
        upstream: null,
      },
    });
    let resolveSecond: ((value: unknown) => void) | undefined;
    status.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      })
    );
    const { rerender, result } = renderHook(
      ({ rootId }: { rootId: string }) =>
        useThreadCheckoutStatus({
          adapterRootId: `adapter-${rootId}`,
          dbRootId: rootId,
          path: `/ws/${rootId}`,
        }),
      { initialProps: { rootId: 'root-a' } }
    );
    await waitFor(() => expect(result.current.checkout?.branch).toBe('root-a-branch'));
    expect(result.current.settled).toBe(true);

    // Second root's status is still in flight: the bar must show nothing
    // rather than root-a's branch under root-b — and this is the ONE case
    // `settled` reads false: a genuinely new root whose first round-trip has
    // not landed yet.
    rerender({ rootId: 'root-b' });
    expect(result.current.checkout).toBeUndefined();
    expect(result.current.settled).toBe(false);

    await act(async () => {
      resolveSecond?.({
        ok: true,
        value: {
          ahead: 0,
          behind: 1,
          branch: 'root-b-branch',
          clean: false,
          files: [],
          isRepository: true,
          upstream: null,
        },
      });
    });
    await waitFor(() =>
      expect(result.current).toEqual({
        checkout: { ahead: 0, behind: 1, branch: 'root-b-branch', dirty: true },
        settled: true,
      })
    );
  });
});
