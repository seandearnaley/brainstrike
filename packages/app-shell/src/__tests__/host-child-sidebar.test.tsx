// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { __resetWorkspaceTabSelectionStoreForTests } from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import {
  type AssistantThreadHostCapability,
  type AssistantThreadHostChild,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { HostChildSidebarCell } from '../host-child-sidebar-cell';
import type { ThreadPanelVisibleRow } from '../thread-panel-visible-rows';
import { useHostChildSidebar } from '../use-host-child-sidebar';

afterEach(() => {
  cleanup();
  __resetWorkspaceTabSelectionStoreForTests();
});

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

it('a host thread’s child row follows the host’s notices and is unread until its tab is opened', async () => {
  let status: AssistantThreadHostChild['status'] = 'working';
  let notify: ((threadId: string) => void) | undefined;
  const host: AssistantThreadHostCapability = {
    childThreads: async () => [child(status)],
    createThread: refused,
    deleteThread: refused,
    isHostThread: (threadId) => threadId === 'root-1',
    listThreads: refused,
    ownsThread: refused,
    renameThread: refused,
    renderThread: () => undefined,
    subscribeChildren: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    updateThreadBinding: refused,
    workspaceRepository: (history) => history,
  };
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
  expect(
    await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Needs input$/u })
  ).toBeVisible();

  status = 'idle';
  act(() => notify?.('root-1'));
  // The selected child's change is seen as it happens.
  expect(await screen.findByRole('button', { name: /^Cedar-1a2b3c\s*Child$/u })).toBeVisible();
});
