import type { WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarness } from './fixtures/thread-workspace-harness';

let prepareRendererClose: typeof import('@brainstrike/app-state/renderer-close').prepareRendererClose;
let useThreadWorkspaceCoordinator: typeof import('../use-thread-workspace-coordinator').useThreadWorkspaceCoordinator;

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
