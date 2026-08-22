import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useThreadCheckoutStatus } from '../hooks/use-thread-checkout-status';

const status = vi.fn();

beforeEach(() => {
  useChangesLiveRefreshStore.getState().reset();
  (window as Window & { git?: unknown }).git = {
    aheadBehind: vi.fn(),
    commit: vi.fn(),
    commitFiles: vi.fn(),
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
      useThreadCheckoutStatus({ path: '/ws/a', rootId: 'root-a' })
    );
    await waitFor(() =>
      expect(result.current).toEqual({ ahead: 2, behind: 0, branch: 'main', dirty: false })
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
      expect(result.current).toEqual({ ahead: null, behind: null, branch: null, dirty: true })
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
      useThreadCheckoutStatus({ path: '/ws/a', rootId: 'root-a' })
    );
    await waitFor(() => expect(result.current?.dirty).toBe(false));
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
    await waitFor(() => expect(result.current?.dirty).toBe(true));
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
      useThreadCheckoutStatus({ path: '/ws/a', rootId: 'root-a' })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();

    const { result: nullRoot } = renderHook(() => useThreadCheckoutStatus(null));
    expect(nullRoot.current).toBeUndefined();

    (window as Window & { git?: unknown }).git = undefined;
    const { result: noBridge } = renderHook(() =>
      useThreadCheckoutStatus({ path: '/ws/a', rootId: 'root-a' })
    );
    expect(noBridge.current).toBeUndefined();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed status as undefined and logs — never a fake clean state', async () => {
    status.mockResolvedValueOnce({ error: 'boom', ok: false });
    const { result } = renderHook(() =>
      useThreadCheckoutStatus({ path: '/ws/a', rootId: 'root-a' })
    );
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(result.current).toBeUndefined();
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
        useThreadCheckoutStatus({ path: `/ws/${rootId}`, rootId }),
      { initialProps: { rootId: 'root-a' } }
    );
    await waitFor(() => expect(result.current?.branch).toBe('root-a-branch'));

    // Second root's status is still in flight: the bar must show nothing
    // rather than root-a's branch under root-b.
    rerender({ rootId: 'root-b' });
    expect(result.current).toBeUndefined();

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
      expect(result.current).toEqual({ ahead: 0, behind: 1, branch: 'root-b-branch', dirty: true })
    );
  });
});
