import './assistant-thread-tabs-workspace-test-support';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import type { AssistantThreadHostCapability } from '../assistant-thread-host-context';
import { renderWorkspace } from './assistant-thread-tabs-workspace-test-support';

test.each(['empty', 'current'] as const)(
  'failed catalog stays explicit until a successful %s reload',
  async (result) => {
    const current = {
      createdAt: new Date(),
      id: 'owned-current',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'Current conversation',
      updatedAt: new Date(),
    };
    const host: AssistantThreadHostCapability = {
      createThread: vi.fn(async () => current),
      deleteThread: vi.fn(async () => undefined),
      listThreads: vi
        .fn()
        .mockRejectedValueOnce(new Error('Catalog unavailable'))
        .mockRejectedValueOnce(new Error('Catalog still unavailable'))
        .mockResolvedValueOnce(result === 'empty' ? [] : [current]),
      ownsThread: vi.fn(async () => true),
      renameThread: vi.fn(),
      renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
      renderThread: (threadId) => <div data-testid="host-thread">{threadId}</div>,
      updateThreadBinding: vi.fn(),
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'saved-current' },
      openThreadIdsByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: ['saved-current'] },
      selectedThreadByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'saved-current' },
    });
    renderWorkspace({}, host);
    expect(await screen.findByText('Catalog unavailable')).toBeVisible();
    expect(screen.queryByText(/This thread is no longer available/u)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry loading conversations' }));
    expect(await screen.findByText('Catalog still unavailable')).toBeVisible();
    expect(host.createThread).not.toHaveBeenCalled();
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('saved-current');
    await user.click(screen.getByRole('button', { name: 'Retry loading conversations' }));
    if (result === 'empty') {
      // An empty catalog opens the new-thread screen; no thread is created for it.
      expect(await screen.findByTestId('new-thread-composer')).toBeVisible();
      expect(screen.getByText(/This thread is no longer available/u)).toBeVisible();
    } else {
      expect(await screen.findByTestId('host-thread')).toHaveTextContent('owned-current');
    }
    expect(screen.queryByText('Catalog still unavailable')).not.toBeInTheDocument();
    expect(host.listThreads).toHaveBeenCalledTimes(3);
    expect(host.createThread).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'New assistant thread' })).toBeEnabled();
  }
);

test('a tab never shows its raw thread id, and the load-error card retries in place', async () => {
  const current = {
    createdAt: new Date(),
    id: 'saved-current',
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'Current conversation',
    updatedAt: new Date(),
  };
  let failFirstLoad: (error: Error) => void = () => undefined;
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(async () => current),
    deleteThread: vi.fn(async () => undefined),
    listThreads: vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failFirstLoad = reject;
        })
      )
      .mockResolvedValueOnce([current]),
    ownsThread: vi.fn(async () => true),
    renameThread: vi.fn(),
    renderNewThread: (resourceId) => <div data-testid="new-thread-composer">{resourceId}</div>,
    renderThread: (threadId) => <div data-testid="host-thread">{threadId}</div>,
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'saved-current' },
    openThreadIdsByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: ['saved-current'] },
    selectedThreadByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'saved-current' },
  });
  renderWorkspace({}, host);

  expect(await screen.findByRole('tab', { name: /Loading…/u })).toBeVisible();
  expect(screen.queryByRole('tab', { name: /saved-current/u })).not.toBeInTheDocument();

  failFirstLoad(new Error('Catalog unavailable'));
  const card = await screen.findByTestId('assistant-thread-workspace-state');
  expect(card).toHaveTextContent('Catalog unavailable');
  expect(screen.getByRole('tab', { name: /Untitled thread/u })).toBeVisible();

  await userEvent.setup().click(within(card).getByRole('button', { name: 'Retry' }));

  expect(await screen.findByRole('tab', { name: /Current conversation/u })).toBeVisible();
  expect(screen.getByTestId('host-thread')).toHaveTextContent('saved-current');
  expect(screen.queryByTestId('assistant-thread-workspace-state')).not.toBeInTheDocument();
});
