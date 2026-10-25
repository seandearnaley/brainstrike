import {
  EMPTY_WORKSPACE_SNAPSHOT,
  type ThreadWorkspaceRepository,
  type WorkspaceSnapshotV1,
} from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useThreadWorkspaceCoordinator } from '../use-thread-workspace-coordinator';
import { createHarness } from './fixtures/thread-workspace-harness';

const RESOURCE_ID = 'brainstrike:workspace';
const TAB = 'root-1:src/app.ts';
const CLOSED = { expandedPaths: [], open: false, widthPct: 30 };

/** The stored workspace of a thread whose file pane the user closed. */
const CLOSED_PANE: WorkspaceSnapshotV1 = {
  ...EMPTY_WORKSPACE_SNAPSHOT,
  apps: { openAppIds: ['context-explorer'], selection: { kind: 'file', tabId: TAB } },
  editors: { [TAB]: { pane: CLOSED } },
  fileTabs: { activeTabId: TAB, tabs: [{ compositeKey: TAB, path: 'src/app.ts' }] },
};

function mount(
  harness: ReturnType<typeof createHarness>,
  repository: ThreadWorkspaceRepository | null
) {
  return renderHook(
    ({ currentRepository }) =>
      useThreadWorkspaceCoordinator({
        activeThreadId: 'thread-a',
        facade: harness.facade,
        navigation: harness.navigation,
        openThreadIds: [],
        repository: currentRepository,
        resourceId: RESOURCE_ID,
        subscribe: harness.subscribe,
      }),
    { initialProps: { currentRepository: repository } }
  );
}

/** Settles the microtasks a resolved read and its hydration chain queue. */
async function drain(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve();
    }
  });
}

/** Records whether the join settled, and the panes the live stores held when it did. */
function observe(join: Promise<void>, harness: ReturnType<typeof createHarness>) {
  const outcome: { error?: unknown; panesAtJoin?: unknown[][]; settled: boolean } = {
    settled: false,
  };
  const settled = join.then(
    () => {
      outcome.settled = true;
      outcome.panesAtJoin = [...vi.mocked(harness.facade.applyPanes).mock.calls];
    },
    (error: unknown) => {
      outcome.settled = true;
      outcome.error = error;
    }
  );
  return { outcome, settled };
}

describe("joining a thread's workspace (BST-2288)", () => {
  it('resolves once the held hydration read is applied to the live stores, never before', async () => {
    const harness = createHarness();
    const read = Promise.withResolvers<WorkspaceSnapshotV1 | null>();
    vi.mocked(harness.repository.getThreadWorkspace).mockReturnValueOnce(read.promise);
    const mounted = mount(harness, harness.repository);
    const { outcome, settled } = observe(
      harness.navigation.whenReady(RESOURCE_ID, 'thread-a'),
      harness
    );
    try {
      await drain();
      expect(outcome.settled).toBe(false);

      read.resolve(CLOSED_PANE);
      await drain();
      await settled;
      expect(outcome.error).toBeUndefined();
      expect(outcome.panesAtJoin).toEqual([[{ [TAB]: CLOSED }]]);
    } finally {
      mounted.unmount();
    }
  });

  it('waits through a boot that has no database yet, then for the deferred hydration', async () => {
    const harness = createHarness();
    harness.rows.set('thread-a', CLOSED_PANE);
    const mounted = mount(harness, null);
    const { outcome, settled } = observe(
      harness.navigation.whenReady(RESOURCE_ID, 'thread-a'),
      harness
    );
    try {
      await drain();
      expect(outcome.settled).toBe(false);
      expect(harness.repository.getThreadWorkspace).not.toHaveBeenCalled();

      mounted.rerender({ currentRepository: harness.repository });
      await drain();
      await settled;
      expect(outcome.error).toBeUndefined();
      expect(outcome.panesAtJoin).toEqual([[{ [TAB]: CLOSED }]]);
    } finally {
      mounted.unmount();
    }
  });

  it('rejects with the failure when the hydration read fails', async () => {
    const harness = createHarness();
    const failure = new Error('workspace read failed');
    vi.mocked(harness.repository.getThreadWorkspace).mockRejectedValueOnce(failure);
    const mounted = mount(harness, harness.repository);
    const { outcome, settled } = observe(
      harness.navigation.whenReady(RESOURCE_ID, 'thread-a'),
      harness
    );
    try {
      await drain();
      await settled;
      expect(outcome.error).toBe(failure);
      expect(harness.facade.applyPanes).not.toHaveBeenCalled();
    } finally {
      mounted.unmount();
    }
  });

  it('rejects at once for a join that arrives after the hydration read failed', async () => {
    const harness = createHarness();
    const failure = new Error('workspace read failed');
    vi.mocked(harness.repository.getThreadWorkspace).mockRejectedValueOnce(failure);
    const mounted = mount(harness, harness.repository);
    try {
      await drain();
      const { outcome, settled } = observe(
        harness.navigation.whenReady(RESOURCE_ID, 'thread-a'),
        harness
      );
      await drain();
      expect(outcome.settled).toBe(true);
      await settled;
      expect(outcome.error).toBe(failure);
    } finally {
      mounted.unmount();
    }
  });

  it('resolves at once for the workspace the coordinator already applied', async () => {
    const harness = createHarness();
    harness.rows.set('thread-a', CLOSED_PANE);
    const mounted = mount(harness, harness.repository);
    try {
      await drain();
      expect(harness.facade.applyPanes).toHaveBeenCalledTimes(1);

      const { outcome, settled } = observe(
        harness.navigation.whenReady(RESOURCE_ID, 'thread-a'),
        harness
      );
      await settled;
      expect(outcome.error).toBeUndefined();
      expect(harness.repository.getThreadWorkspace).toHaveBeenCalledTimes(1);
    } finally {
      mounted.unmount();
    }
  });
});
