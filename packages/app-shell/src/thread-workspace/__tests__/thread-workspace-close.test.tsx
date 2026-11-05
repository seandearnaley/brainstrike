import type { BoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import type { WorkspaceSnapshotV1 } from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
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
    // Each test is its own profile: durable renderer stores read localStorage at import.
    window.localStorage.clear();
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

  // The host was stopped just before quit: the write waits on the one reconnect, which quit's
  // fenced profile refuses. Nothing is left to deliver; only a fault fails the close.
  it.each([
    [
      'refused because its owner is unavailable',
      {
        category: 'availability',
        code: 'platform.closing',
        kind: 'refusal',
        message: 'The desktop is closing this agent host.',
      },
      undefined,
    ],
    [
      'failed',
      {
        category: 'internal',
        code: 'state.write-failed',
        kind: 'fault',
        message: 'The write failed.',
      },
      'Durable writers failed to flush before unload: Thread workspace snapshot writes failed before unload: The write failed.',
    ],
  ] as const)(
    'a closing snapshot write %s settles the close as such',
    async (_outcome, wire: BoundaryFailure, failure) => {
      // The module registry was reset: the coordinator recognises this instance's error class.
      const { BoundaryFailureError } = await import(
        '@brainstrike/assistant-contract/boundary-failure'
      );
      const harness = createHarness();
      const mounted = render(harness, 'thread-a');
      try {
        await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
        vi.mocked(harness.repository.setThreadWorkspace).mockRejectedValueOnce(
          new BoundaryFailureError(wire)
        );
        act(() => {
          harness.state.explorerScrollTop = 240;
          harness.notify();
        });
        const closing = prepareRendererClose();
        await act(async () => {
          await (failure === undefined
            ? expect(closing).resolves.toBeUndefined()
            : expect(closing).rejects.toThrow(failure));
        });
        expect(harness.repository.setThreadWorkspace).toHaveBeenLastCalledWith(
          'thread-a',
          'brainstrike:workspace',
          expect.objectContaining({ explorer: expect.objectContaining({ scrollTop: 240 }) })
        );
      } finally {
        mounted.unmount();
      }
    }
  );

  it('drains to quiescence: a write a pending hydration read admits while the flush waits is joined too', async () => {
    const harness = createHarness();
    const mounted = renderHook(
      ({ activeThreadId }) =>
        useThreadWorkspaceCoordinator({
          activeThreadId,
          debounceMs: 50,
          facade: harness.facade,
          navigation: harness.navigation,
          openThreadIds: OPEN_THREADS,
          repository: harness.repository,
          resourceId: 'brainstrike:workspace',
          subscribe: harness.subscribe,
        }),
      { initialProps: { activeThreadId: 'thread-a' } }
    );
    await waitFor(() => expect(harness.rows.has('thread-a')).toBe(true));
    // Switching to thread-b admits thread-a's outgoing write and starts thread-b's hydration read.
    const outgoingAck = Promise.withResolvers<void>();
    const inheritedAdmitted = Promise.withResolvers<void>();
    const inheritedAck = Promise.withResolvers<void>();
    const read = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
    vi.mocked(harness.repository.getThreadWorkspace).mockReturnValueOnce(read.promise);
    vi.mocked(harness.repository.setThreadWorkspace)
      .mockImplementationOnce(async (id, _owner, snapshot) => {
        await outgoingAck.promise;
        harness.rows.set(id, snapshot);
      })
      .mockImplementationOnce(async (id, _owner, snapshot) => {
        inheritedAdmitted.resolve();
        await inheritedAck.promise;
        harness.rows.set(id, snapshot);
      });
    mounted.rerender({ activeThreadId: 'thread-b' });

    let prepared = false;
    const closing = prepareRendererClose().then(() => {
      prepared = true;
    });
    try {
      // The read settles while the flush waits: thread-b has no row, so it inherits and writes.
      await act(async () => {
        read.resolve(null);
        await inheritedAdmitted.promise;
      });
      outgoingAck.resolve();
      await act(async () => {
        for (let turn = 0; turn < 10; turn += 1) {
          await Promise.resolve();
        }
      });
      expect(prepared).toBe(false);
      expect(harness.rows.has('thread-b')).toBe(false);
    } finally {
      inheritedAck.resolve();
      outgoingAck.resolve();
      await act(async () => {
        await closing;
      });
      mounted.unmount();
    }
    expect(prepared).toBe(true);
    expect(harness.rows.has('thread-b')).toBe(true);
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

  // BST-2281: the close joins writes, never reads. A tab opened while the boot read is still
  // pending has no write to join; the close records the hydration and the next document resumes
  // it. `harness.state` stands in for the persisted tab store and `harness.rows` for the host's
  // rows; both outlive the document, as they do across a real relaunch.
  it.each([
    ['no saved row', false],
    ['a saved row', true],
  ] as const)(
    'a tab opened while the boot read is pending survives quit and relaunch (%s)',
    async (_case, savedRow) => {
      const harness = createHarness();
      if (savedRow) {
        // An earlier session saved thread-a with the Changes tab open.
        await saveSession(harness, 'thread-a', 'changes');
      }

      // Boot: the host is slow to answer thread-a's read. Quit before it does: the close
      // resolves without it, and the document unloads, abandoning the read's continuation.
      await quitWhileBootReadPending(harness, 'thread-a', 'database');

      await relaunch();
      const reopened = render(harness, 'thread-a');
      try {
        await waitFor(() =>
          expect(harness.rows.get('thread-a')?.apps.openAppIds).toContain('database')
        );
        expect(visibleTabs(harness)).toEqual({
          openAppIds: expect.arrayContaining(['database']),
          selection: { appId: 'database', kind: 'app' },
        });
      } finally {
        reopened.unmount();
      }
    }
  );

  it("never merges an interrupted hydration into another thread's workspace", async () => {
    const harness = createHarness();
    await saveSession(harness, 'thread-a', 'context-explorer');
    await saveSession(harness, 'thread-b', 'changes');
    // thread-a's boot is interrupted, then the next document opens thread-b instead and edits it.
    await quitWhileBootReadPending(harness, 'thread-a', 'database');
    await saveSession(harness, 'thread-b', 'logs');

    await relaunch();
    const reopened = render(harness, 'thread-a');
    try {
      await waitFor(() => expect(harness.state.openAppIds).toEqual(['context-explorer']));
      expect(harness.rows.get('thread-a')?.apps.openAppIds).toEqual(['context-explorer']);
    } finally {
      reopened.unmount();
    }
  });
});

/** A relaunched document: a fresh close registry and coordinator module, the same storage. */
async function relaunch(): Promise<void> {
  vi.resetModules();
  ({ prepareRendererClose } = await import('@brainstrike/app-state/renderer-close'));
  ({ useThreadWorkspaceCoordinator } = await import('../use-thread-workspace-coordinator'));
}

/** A document that opens `threadId`, selects `appId` once hydrated, and saves it. */
async function saveSession(
  harness: ReturnType<typeof createHarness>,
  threadId: string,
  appId: string
): Promise<void> {
  await relaunch();
  const session = render(harness, threadId);
  await waitFor(() => expect(harness.rows.has(threadId)).toBe(true));
  act(() => {
    harness.state.openAppIds = [appId];
    harness.state.selection = { appId, kind: 'app' };
    harness.notify();
  });
  await waitFor(() => expect(harness.rows.get(threadId)?.apps.openAppIds).toEqual([appId]));
  session.unmount();
}

/** A document whose boot read of `threadId` never answers: the user opens `appId` and quits. */
async function quitWhileBootReadPending(
  harness: ReturnType<typeof createHarness>,
  threadId: string,
  appId: string
): Promise<void> {
  await relaunch();
  const bootRead = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
  vi.mocked(harness.repository.getThreadWorkspace).mockReturnValueOnce(bootRead.promise);
  const booted = render(harness, threadId);
  act(() => {
    harness.state.openAppIds = [...harness.state.openAppIds, appId];
    harness.state.selection = { appId, kind: 'app' };
    harness.notify();
  });
  await act(async () => {
    await prepareRendererClose();
  });
  booted.unmount();
}

function visibleTabs(harness: ReturnType<typeof createHarness>) {
  return { openAppIds: harness.state.openAppIds, selection: harness.state.selection };
}
