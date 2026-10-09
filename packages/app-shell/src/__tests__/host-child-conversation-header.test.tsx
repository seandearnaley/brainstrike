// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  AssistantThreadHostCapability,
  AssistantThreadHostChild,
} from '../assistant-thread-host-context';
import { HostChildConversationHeader } from '../host-child-conversation-header';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';

const refused = (): Promise<never> => Promise.reject(new Error('not used by a child header'));

function host(
  resolveChildThread: (threadId: string) => Promise<AssistantThreadHostChild>
): AssistantThreadHostCapability {
  return {
    createThread: refused,
    deleteThread: refused,
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderThread: () => undefined,
    resolveChildThread,
    updateThreadBinding: refused,
    workspaceRepository: (history) => history,
  };
}

const worker: AssistantThreadHostChild = {
  callSign: 'Cedar-1a2b3c',
  color: 'family:2000:730',
  depth: 1,
  parentRunId: 'root-run',
  parentThreadId: 'root-1',
  persona: 'worker',
  status: 'idle',
  threadId: 'child-1',
  toolCallId: 'call-1',
};
const explorer: AssistantThreadHostChild = {
  callSign: 'Fern-a1b2c3',
  color: 'family:2000:731',
  depth: 2,
  parentRunId: 'child-run',
  parentThreadId: 'child-1',
  persona: 'explore',
  status: 'idle',
  threadId: 'grandchild-1',
  toolCallId: 'call-2',
};

const openThreadTab = vi.fn();
beforeEach(() => {
  useAssistantThreadStore.setState({
    openThreadTab,
    threadsByResourceId: {
      'workspace-resource': [
        {
          createdAt: new Date(0),
          id: 'root-1',
          metadata: {
            color: 'blue',
            operatingRootDisplayName: 'repo',
            operatingRootId: 'root-a',
          },
          resourceId: 'workspace-resource',
          title: 'Plan the release',
          updatedAt: new Date(0),
        },
      ],
    },
  });
});
afterEach(() => {
  cleanup();
  openThreadTab.mockReset();
  __resetWorkspaceTabSelectionStoreForTests();
});

it('names a grandchild’s ancestry from its root, through its parent, to its own call sign', async () => {
  const resolve = vi.fn(async (threadId: string) => {
    if (threadId !== 'child-1') {
      throw new Error(`Unexpected ancestor ${threadId}`);
    }
    return worker;
  });
  render(<HostChildConversationHeader child={explorer} host={host(resolve)} />);
  const ancestry = await screen.findByRole('navigation', { name: 'Conversation ancestry' });
  expect(
    within(ancestry)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
  ).toEqual(['Plan the release', 'Cedar-1a2b3c', 'Fern-a1b2c3']);
  expect(screen.getByRole('heading', { name: 'Fern-a1b2c3' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'Parent: Cedar-1a2b3c' })).toBeVisible();
  expect(screen.getByRole('banner')).toHaveAttribute('data-agent-color', 'family:2000:731');
  expect(screen.getByTestId('child-workspace-mode')).toHaveTextContent('Shared workspace: repo');

  // Each ancestor opens where it lives: the parent child's tab, the root's thread tab.
  await userEvent.click(within(ancestry).getByRole('button', { name: 'Cedar-1a2b3c' }));
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).toContain(
    hostChildWorkspaceTabId({ persona: 'worker', threadId: 'child-1' })
  );
  await userEvent.click(within(ancestry).getByRole('button', { name: 'Plan the release' }));
  expect(openThreadTab).toHaveBeenCalledExactlyOnceWith('workspace-resource', 'root-1');
});

it('a root’s own child names the root as its parent', async () => {
  render(<HostChildConversationHeader child={worker} host={host(refused)} />);
  const ancestry = await screen.findByRole('navigation', { name: 'Conversation ancestry' });
  expect(
    within(ancestry)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
  ).toEqual(['Plan the release', 'Cedar-1a2b3c']);
  expect(screen.getByRole('img', { name: 'Parent: Plan the release' })).toBeVisible();
});

it('shows why an ancestor could not be resolved', async () => {
  render(
    <HostChildConversationHeader
      child={explorer}
      host={host(() => Promise.reject(new Error('Unknown thread')))}
    />
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown thread');
  expect(screen.queryByRole('navigation', { name: 'Conversation ancestry' })).toBeNull();
});
