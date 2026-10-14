// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  type AssistantThreadHostCapability,
  type AssistantThreadHostChild,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { HostChildWorkspaceChip } from '../host-child-workspace-chip';

const threads = useAssistantThreadStore.getState();
afterEach(() => {
  cleanup();
  useAssistantThreadStore.setState(threads, true);
});

const refused = (): Promise<never> => Promise.reject(new Error('not used by the chip'));

function child(threadId: string, parentThreadId: string, depth: number): AssistantThreadHostChild {
  return {
    callSign: `Child-${threadId}`,
    color: 'family:2000:730',
    depth,
    parentRunId: `${parentThreadId}-run`,
    parentThreadId,
    persona: 'worker',
    status: 'idle',
    threadId,
    toolCallId: `${threadId}-call`,
  };
}

/** Core lists only top-level threads: a child has no row; its root does. */
const tree = new Map([
  ['child-1', child('child-1', 'root-1', 1)],
  ['grand-1', child('grand-1', 'child-1', 2)],
]);
const host: AssistantThreadHostCapability = {
  createThread: refused,
  deleteThread: refused,
  listThreads: refused,
  ownsThread: refused,
  renameThread: refused,
  renderThread: () => undefined,
  resolveChildThread: async (threadId) => {
    const found = tree.get(threadId);
    if (!found) {
      throw new Error(`Unknown child ${threadId}`);
    }
    return found;
  },
  updateThreadBinding: refused,
  workspaceRepository: () => {
    throw new Error('Unexpected workspace snapshot access in this fixture');
  },
};

function renderChip(threadId: string) {
  return render(
    <AssistantThreadHostContext.Provider value={host}>
      <HostChildWorkspaceChip threadId={threadId} />
    </AssistantThreadHostContext.Provider>
  );
}

beforeEach(() => {
  useAssistantThreadStore.setState({
    threadsByResourceId: {
      [WORKSPACE_MEMORY_RESOURCE_ID]: [
        {
          createdAt: new Date(0),
          id: 'root-1',
          metadata: {
            operatingRootDisplayName: 'shared-repo',
            operatingRootId: 'root-folder-1',
            operatingRootPath: '/work/shared-repo',
          },
          resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
          title: 'Plan the release',
          updatedAt: new Date(0),
        },
      ],
    },
  });
});

it("names its root thread's folder, read-only, at any depth", async () => {
  for (const threadId of ['child-1', 'grand-1']) {
    const { unmount } = renderChip(threadId);
    const chip = await screen.findByTestId('workspace-bar-shared-folder');
    expect(chip).toHaveTextContent('Shared workspace: shared-repo');
    expect(chip).toHaveAttribute('title', '/work/shared-repo');
    // The root owns the folder: the child offers no way to add or change it.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('Choose a folder')).toBeNull();
    unmount();
  }
});

it('says when its root has no folder, and names a failed ancestry read', async () => {
  useAssistantThreadStore.setState({ threadsByResourceId: {} });
  const { unmount } = renderChip('child-1');
  expect(await screen.findByTestId('workspace-bar-shared-folder')).toHaveTextContent(
    'Shared workspace: tools select an open folder'
  );
  unmount();
  renderChip('missing');
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown child missing');
});
