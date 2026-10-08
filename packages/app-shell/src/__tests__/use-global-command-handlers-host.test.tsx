import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useGlobalCommandHandlers } from '../use-global-command-handlers';

const { history } = vi.hoisted(() => ({ history: { createThread: vi.fn() } }));
vi.mock('@brainstrike/assistant-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/assistant-data')>()),
  createPgliteAssistantThreadRepository: () => history,
}));
vi.mock('../workspace-connect/use-connect-folder', () => ({
  useConnectFolder: () => ({ openPicker: vi.fn() }),
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useTheme: () => ({ setTheme: vi.fn(), theme: 'light' }),
}));

const DATABASE = { kind: 'database' } as unknown as DbHandle;

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
    history.createThread.mockResolvedValue(thread('legacy-thread'));
    useAssistantThreadStore.setState({ threadsByResourceId: {} });
  });

  it('creates the thread through the host owner when the app has one', async () => {
    const host: AssistantThreadHostCapability = {
      createThread: vi.fn(async () => thread('host-thread')),
      deleteThread: vi.fn(),
      listThreads: vi.fn(async () => []),
      ownsThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(),
      workspaceRepository: (repository) => repository,
    };
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(AssistantThreadHostContext.Provider, { value: host }, children);
    const { result } = renderHook(() => useGlobalCommandHandlers(DATABASE), { wrapper });

    await act(async () => {
      await result.current.newThread?.();
    });

    expect(host.createThread).toHaveBeenCalledExactlyOnceWith(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(history.createThread).not.toHaveBeenCalled();
    expect(
      useAssistantThreadStore.getState().activeThreadIdByResourceId[WORKSPACE_MEMORY_RESOURCE_ID]
    ).toBe('host-thread');
  });

  it('keeps the history repository when there is no host', async () => {
    const { result } = renderHook(() => useGlobalCommandHandlers(DATABASE));

    await act(async () => {
      await result.current.newThread?.();
    });

    expect(history.createThread).toHaveBeenCalledOnce();
  });
});
