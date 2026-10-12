// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import {
  type AssistantThreadHostCapability,
  type AssistantThreadHostChild,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { HostChildSidebarCell } from '../host-child-sidebar-cell';
import { hostChildWorkspaceTabId } from '../host-child-workspace-tab';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';
import { threadWorkspaceNavigation } from '../thread-workspace/live-thread-workspace-navigation';
import { useHostChildSidebar } from '../use-host-child-sidebar';

const threads = useAssistantThreadStore.getState();
afterEach(() => {
  cleanup();
  __resetWorkspaceTabSelectionStoreForTests();
  useAssistantThreadStore.setState(threads, true);
  // No root's workspace stays ready for the next test's navigation.
  threadWorkspaceNavigation.loading('workspace', null);
});

const CHILD_TAB = hostChildWorkspaceTabId({ persona: 'worker', threadId: 'child-1' });

const refused = (): Promise<never> => Promise.reject(new Error('not used by the sidebar'));

function child(status: AssistantThreadHostChild['status']): AssistantThreadHostChild {
  return {
    callSign: 'Cedar-1a2b3c',
    color: 'family:2000:730',
    depth: 1,
    parentRunId: 'root-run',
    parentThreadId: 'root-1',
    persona: 'worker',
    status,
    threadId: 'child-1',
    toolCallId: 'call-1',
  };
}

const root: ThreadPanelVisibleRow = {
  groupId: null,
  id: 'root-1',
  kind: 'thread',
  parentId: null,
  thread: {
    createdAt: new Date(0),
    id: 'root-1',
    resourceId: 'workspace',
    title: 'Plan the release',
    updatedAt: new Date(0),
  },
};

/** The threads panel's use of the hook: a root row that expands, then its child rows. */
function Panel() {
  const sidebar = useHostChildSidebar();
  return (
    <>
      {sidebar.project([root]).map((row) => {
        if (row.kind === 'host-child') {
          return <HostChildSidebarCell key={row.id} row={row} />;
        }
        if (row.kind === 'thread') {
          return (
            <button key={row.id} onClick={() => sidebar.toggle(row)} type="button">
              Expand {row.thread.title}
            </button>
          );
        }
        return <p key={row.id}>{row.kind === 'delegated-state' ? row.label : null}</p>;
      })}
    </>
  );
}

function hostWith(
  childThreads: NonNullable<AssistantThreadHostCapability['childThreads']>,
  subscribeChildren: NonNullable<AssistantThreadHostCapability['subscribeChildren']>
): AssistantThreadHostCapability {
  return {
    childThreads,
    createThread: refused,
    deleteThread: refused,
    isHostThread: (threadId) => threadId === 'root-1',
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderThread: () => undefined,
    subscribeChildren,
    updateThreadBinding: refused,
    workspaceRepository: (history) => history,
  };
}

it('a child’s row opens it in its own root’s workspace, whichever root is open', async () => {
  useAssistantThreadStore.getState().openThreadTab('workspace', 'other-root');
  render(
    <AssistantThreadHostContext.Provider
      value={hostWith(
        async () => [child('idle')],
        () => () => undefined
      )}
    >
      <Panel />
    </AssistantThreadHostContext.Provider>
  );
  await userEvent.click(screen.getByRole('button', { name: 'Expand Plan the release' }));
  await userEvent.click(await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Child$/u }));
  // The child's root opens first; its tab opens once that root's workspace is ready.
  expect(useAssistantThreadStore.getState().activeThreadIdByResourceId['workspace']).toBe('root-1');
  expect(useWorkspaceTabSelectionStore.getState().openAppIds).not.toContain(CHILD_TAB);
  act(() => threadWorkspaceNavigation.complete('workspace', 'root-1'));
  expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
    appId: CHILD_TAB,
    kind: 'app',
  });
});

it('a host thread’s child row follows the host’s notices and is unread until its tab is opened', async () => {
  let status: AssistantThreadHostChild['status'] = 'working';
  let notify: ((threadId: string) => void) | undefined;
  const host = hostWith(
    async () => [child(status)],
    (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    }
  );
  render(
    <AssistantThreadHostContext.Provider value={host}>
      <Panel />
    </AssistantThreadHostContext.Provider>
  );
  await userEvent.click(screen.getByRole('button', { name: 'Expand Plan the release' }));
  // jsdom applies no layout, so the flex items' names join without the browser's spaces.
  expect(await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Working$/u })).toBeVisible();

  status = 'needs-input';
  act(() => notify?.('root-1'));
  const unread = await screen.findByRole('button', {
    name: /^Cedar-1a2b3c\s*Unread child activity\s*Needs input$/u,
  });
  // Opening the child's tab sees its change.
  await userEvent.click(unread);
  act(() => threadWorkspaceNavigation.complete('workspace', 'root-1'));
  expect(
    await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Needs input$/u })
  ).toBeVisible();

  status = 'idle';
  act(() => notify?.('root-1'));
  // The selected child's change is seen as it happens.
  expect(await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Child$/u })).toBeVisible();
});
