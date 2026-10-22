import './assistant-thread-tabs-workspace-test-support';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  AssistantThreadHostCapability,
  AssistantThreadHostRun,
} from '../assistant-thread-host-context';
import {
  assistantWrapperProps,
  renderWorkspace,
} from './assistant-thread-tabs-workspace-test-support';

function hostCatalog(): AssistantThreadHostCapability {
  const thread = {
    createdAt: new Date(),
    id: 'owned-current',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Current conversation',
    updatedAt: new Date(),
  };
  return {
    createThread: vi.fn(async () => ({ ...thread, id: 'owned-new', title: 'New conversation' })),
    deleteThread: vi.fn(async () => undefined),
    listThreads: vi.fn(async () => [thread]),
    ownsThread: vi.fn(async () => true),
    renameThread: vi.fn(),
    renderThread: (threadId) => <div data-testid="host-thread">{threadId}</div>,
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test('host catalog loads and creates a chat', async () => {
  const host = hostCatalog();
  renderWorkspace({}, host);
  expect(await screen.findByTestId('host-thread')).toHaveTextContent('owned-current');
  await userEvent.setup().click(screen.getByRole('button', { name: 'New assistant thread' }));
  expect(await screen.findByRole('tab', { name: /New conversation/ })).toBeVisible();
  expect(host.createThread).toHaveBeenCalledExactlyOnceWith(WORKSPACE_MEMORY_RESOURCE_ID);
  expect(assistantWrapperProps).toEqual([]);
});

test('a missing host renderer refuses rather than mounting a panel', async () => {
  const host = hostCatalog();
  host.renderThread = () => undefined;
  renderWorkspace({}, host);
  expect(await screen.findByText('Conversation unavailable')).toBeVisible();
  expect(assistantWrapperProps).toEqual([]);
});

test('host run notifications update tab status and unsubscribe', async () => {
  const listeners = new Set<() => void>();
  let runs = new Map<string, AssistantThreadHostRun>([
    ['owned-current', { completedAt: null, needsInput: false, status: 'running' }],
  ]);
  const host = hostCatalog();
  renderWorkspace(
    {},
    {
      ...host,
      runs: {
        getSnapshot: () => runs,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
    }
  );
  expect(await screen.findByRole('tab', { name: /Current conversation.*running/ })).toBeVisible();
  act(() => {
    runs = new Map([['owned-current', { completedAt: null, needsInput: true, status: 'running' }]]);
    for (const listener of listeners) {
      listener();
    }
  });
  expect(screen.getByRole('tab', { name: /Current conversation.*needs your input/ })).toBeVisible();
  cleanup();
  expect(listeners.size).toBe(0);
});
