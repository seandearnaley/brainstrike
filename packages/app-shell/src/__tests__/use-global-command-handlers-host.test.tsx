import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useGlobalCommandHandlers } from '../use-global-command-handlers';

vi.mock('../workspace-connect/use-connect-folder', () => ({
  useConnectFolder: () => ({ openPicker: vi.fn() }),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
}));

function thread(id: string) {
  return {
    createdAt: new Date('2026-10-08T00:00:00Z'),
    id,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    title: 'New Thread',
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  };
}

describe('useGlobalCommandHandlers new thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAssistantThreadStore.setState({ threadsByResourceId: {} });
  });

  it('opens the new-thread screen without creating a thread when the app has a host', async () => {
    const host: AssistantThreadHostCapability = {
      createThread: vi.fn(async () => thread('host-thread')),
      deleteThread: vi.fn(),
      listThreads: vi.fn(async () => []),
      ownsThread: vi.fn(),
      renameThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(),
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(AssistantThreadHostContext.Provider, { value: host }, children);
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'open-thread' },
      openThreadIdsByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: ['open-thread'] },
    });
    const { result } = renderHook(() => useGlobalCommandHandlers(), { wrapper });

    await act(async () => {
      await result.current.newThread?.();
    });

    expect(host.createThread).not.toHaveBeenCalled();
    // Open tabs stay open behind the new-thread screen.
    expect(
      useAssistantThreadStore.getState().openThreadIdsByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toEqual(['open-thread']);
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBeUndefined();
  });
});
