import './assistant-thread-tabs-workspace-test-support';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { screen } from '@testing-library/react';
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
    expect(screen.queryByText(/Your saved conversation is unavailable/)).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry loading conversations' }));
    expect(await screen.findByText('Catalog still unavailable')).toBeVisible();
    expect(host.createThread).not.toHaveBeenCalled();
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('saved-current');
    await user.click(screen.getByRole('button', { name: 'Retry loading conversations' }));
    expect(await screen.findByTestId('host-thread')).toHaveTextContent('owned-current');
    expect(screen.queryByText('Catalog still unavailable')).not.toBeInTheDocument();
    expect(host.listThreads).toHaveBeenCalledTimes(3);
    expect(host.createThread).toHaveBeenCalledTimes(result === 'empty' ? 1 : 0);
    expect(screen.getByRole('button', { name: 'New assistant thread' })).toBeEnabled();
  }
);
