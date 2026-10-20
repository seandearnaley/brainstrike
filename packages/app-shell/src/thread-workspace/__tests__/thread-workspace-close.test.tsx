import type { WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './fixtures/thread-workspace-harness';

let prepareRendererClose: typeof import('@brainstrike/app-state/renderer-close').prepareRendererClose;
let useThreadWorkspaceCoordinator: typeof import('../use-thread-workspace-coordinator').useThreadWorkspaceCoordinator;

const OPEN_THREADS = ['thread-a', 'thread-b'] as const;

function render(harness: ReturnType<typeof createHarness>, initialThread: string) {
  const openThreadIds = [initialThread];
  return renderHook(() =>
    useThreadWorkspaceCoordinator({
      activeThreadId: initialThread,
      debounceMs: 50,
      facade: harness.facade,
      navigation: harness.navigation,
      openThreadIds,
      repository: harness.repository,
      resourceId: 'brainstrike:workspace',
      subscribe: harness.subscribe,
    })
  );
}

describe('thread workspace app-owned close', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ prepareRendererClose } = await import('@brainstrike/app-state/renderer-close'));
    ({ useThreadWorkspaceCoordinator } = await import('../use-thread-workspace-coordinator'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('flushes the one dirty snapshot and resolves on its acknowledgement while a 20 s read is still pending', async () => {
    const harness = createHarness();
    // The open-tab preload read stays in flight for 20 s: reads are not durable.
    const slowRead = Promise.withResolvers<Map<string, WorkspaceSnapshotV1>>();
    const slowReadTimer = setTimeout(() => slowRead.resolve(new Map()), 20_000);
    vi.mocked(harness.repository.getThreadWorkspaces).mockReturnValueOnce(slowRead.promise);
    const mounted = renderHook(() =>
      useThreadWorkspaceCoordinator({
        activeThreadId: 'thread-a',
        debounceMs: 50,
        facade: harness.facade,
        navigation: harness.navigation,
        openThreadIds: OPEN_THREADS,
        repository: harness.repository,
        resourceId: 'brainstrike:workspace',
        subscribe: harness.subscribe,
      })
    );
    try {
      // thread-a has no row: hydration inherits the live workspace and writes it once.
      await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
      const admitted = Promise.withResolvers<void>();
      const ack = Promise.withResolvers<void>();
      vi.mocked(harness.repository.setThreadWorkspace).mockImplementationOnce(
        async (id, _owner, snapshot) => {
          admitted.resolve();
          await ack.promise;
          harness.rows.set(id, snapshot);
        }
      );
      // A viewport edit is debounced: it is still dirty when the close begins.
      act(() => {
        harness.state.explorerScrollTop = 240;
        harness.notify();
      });
      let prepared = false;
      const closing = prepareRendererClose().then(() => {
        prepared = true;
      });
      await admitted.promise;
      await act(async () => {
        await Promise.resolve();
      });
      expect(prepared).toBe(false);
      ack.resolve();
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) {
          await Promise.resolve();
        }
      });
      expect(prepared).toBe(true);
      await closing;
      expect(harness.rows.get('thread-a')?.explorer.scrollTop).toBe(240);
    } finally {
      clearTimeout(slowReadTimer);
      slowRead.resolve(new Map());
      mounted.unmount();
    }
  });

  it.each(['inherited', 'live-edit after hydration failure'] as const)(
    'close joins an admitted %s snapshot before a reopened coordinator reads it',
    async (branch) => {
      const harness = createHarness();
      const read = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
      const hydrationError = new Error('Expected initial hydration failure');
      const failed = vi.spyOn(harness.navigation, 'failed');
      if (branch === 'inherited') {
        harness.state.openAppIds = ['changes'];
        harness.state.selection = { appId: 'changes', kind: 'app' };
      } else {
        vi.mocked(harness.repository.getThreadWorkspace).mockReturnValueOnce(read.promise);
      }
      const admitted = Promise.withResolvers<void>();
      const ack = Promise.withResolvers<void>();
      vi.mocked(harness.repository.setThreadWorkspace).mockImplementationOnce(
        async (id, _owner, snapshot) => {
          admitted.resolve();
          await ack.promise;
          harness.rows.set(id, snapshot);
        }
      );
      const mounted = render(harness, 'thread-a');
      if (branch !== 'inherited') {
        act(() => {
          harness.state.openAppIds = ['changes'];
          harness.state.selection = { appId: 'changes', kind: 'app' };
          harness.notify();
        });
        await act(async () => {
          read.reject(hydrationError);
        });
        expect(failed).toHaveBeenCalledWith('brainstrike:workspace', 'thread-a', hydrationError);
      }
      await admitted.promise;
      let prepared = false;
      const closing = prepareRendererClose().then(() => {
        prepared = true;
      });
      try {
        await act(async () => {
          await Promise.resolve();
        });
        expect(prepared).toBe(false);
        expect(harness.rows.has('thread-a')).toBe(false);
      } finally {
        ack.resolve();
        await act(async () => {
          await closing;
        });
        mounted.unmount();
      }
      expect(prepared).toBe(true);
      expect(harness.rows.get('thread-a')?.apps).toEqual({
        openAppIds: ['changes'],
        selection: { appId: 'changes', kind: 'app' },
      });
      vi.resetModules();
      ({ useThreadWorkspaceCoordinator } = await import('../use-thread-workspace-coordinator'));
      harness.state.openAppIds = ['context-explorer'];
      harness.state.selection = { appId: 'context-explorer', kind: 'app' };
      const reopened = render(harness, 'thread-a');
      await waitFor(() => expect(harness.state.openAppIds).toEqual(['changes']));
      expect(harness.state.selection).toEqual({ appId: 'changes', kind: 'app' });
      reopened.unmount();
    }
  );
});
