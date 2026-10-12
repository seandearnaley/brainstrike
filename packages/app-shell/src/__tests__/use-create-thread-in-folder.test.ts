import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useCreateThreadInFolder } from '../hooks/use-create-thread-in-folder';

const {
  createPgliteAssistantThreadRepositoryMock,
  createThreadMock,
  toastMock,
  updateThreadMetadataMock,
  useAssistantThreadStoreMock,
  usePGliteDatabaseMock,
} = vi.hoisted(() => {
  const createThread = vi.fn();
  const updateThreadMetadata = vi.fn();
  return {
    createPgliteAssistantThreadRepositoryMock: vi.fn(),
    createThreadMock: createThread,
    toastMock: vi.fn(),
    updateThreadMetadataMock: updateThreadMetadata,
    useAssistantThreadStoreMock: vi.fn(
      (
        selector: (state: {
          createThread: typeof createThread;
          updateThreadMetadata: typeof updateThreadMetadata;
        }) => unknown
      ) => selector({ createThread, updateThreadMetadata })
    ),
    usePGliteDatabaseMock: vi.fn(),
  };
});

vi.mock('@brainstrike/assistant-data', () => ({
  createPgliteAssistantThreadRepository: createPgliteAssistantThreadRepositoryMock,
  useAssistantThreadStore: useAssistantThreadStoreMock,
  WORKSPACE_MEMORY_RESOURCE_ID: 'workspace-memory',
}));

vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: usePGliteDatabaseMock,
}));

vi.mock('@brainstrike/ui', () => ({ toast: toastMock }));

describe('useCreateThreadInFolder', () => {
  const database = { name: 'test-database' };
  const repository = { name: 'test-repository' };

  beforeEach(() => {
    vi.clearAllMocks();
    usePGliteDatabaseMock.mockReturnValue(database);
    createPgliteAssistantThreadRepositoryMock.mockReturnValue(repository);
    createThreadMock.mockResolvedValue({ id: 'thread-1' });
    updateThreadMetadataMock.mockResolvedValue(undefined);
  });

  it('creates one thread before writing the complete operating-root binding once', async () => {
    const { result } = renderHook(() => useCreateThreadInFolder());

    result.current?.({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });

    await waitFor(() => expect(updateThreadMetadataMock).toHaveBeenCalledOnce());
    expect(createThreadMock).toHaveBeenCalledExactlyOnceWith(repository, 'workspace-memory');
    expect(updateThreadMetadataMock).toHaveBeenCalledExactlyOnceWith(
      repository,
      'workspace-memory',
      'thread-1',
      {
        operatingRootDisplayName: 'brainstrike',
        operatingRootId: 'root-1',
        operatingRootPath: '/Users/dev/GitHub/brainstrike',
      }
    );
    expect(createThreadMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateThreadMetadataMock.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY
    );
  });

  it('omits operatingRootPath when the folder has no path', async () => {
    const { result } = renderHook(() => useCreateThreadInFolder());

    result.current?.({ displayName: 'notes', path: null, rootId: 'root-web-1' });

    await waitFor(() => expect(updateThreadMetadataMock).toHaveBeenCalledOnce());
    expect(updateThreadMetadataMock).toHaveBeenCalledWith(
      repository,
      'workspace-memory',
      'thread-1',
      {
        operatingRootDisplayName: 'notes',
        operatingRootId: 'root-web-1',
      }
    );
    expect(updateThreadMetadataMock.mock.calls[0]?.[3]).not.toHaveProperty('operatingRootPath');
  });

  it('surfaces a rejected metadata write without retrying it', async () => {
    updateThreadMetadataMock.mockRejectedValueOnce(new Error('metadata unavailable'));
    const { result } = renderHook(() => useCreateThreadInFolder());

    result.current?.({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledExactlyOnceWith({
        description:
          'Could not bind it to brainstrike. Open the thread and select brainstrike to retry. Error: metadata unavailable',
        title: 'Thread created in No folder',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadataMock).toHaveBeenCalledOnce();
  });

  it('creates through the host and reports a refused host binding without a legacy fallback', async () => {
    const history = { createThread: vi.fn(), updateThreadMetadata: vi.fn() };
    createPgliteAssistantThreadRepositoryMock.mockReturnValue(history);
    createThreadMock.mockImplementation(
      (owner: { createThread: (resourceId: string) => Promise<{ id: string }> }, resourceId) =>
        owner.createThread(resourceId)
    );
    updateThreadMetadataMock.mockImplementation(
      (
        owner: { updateThreadMetadata: (id: string, metadata: unknown) => Promise<void> },
        _resourceId: string,
        threadId: string,
        metadata: unknown
      ) => owner.updateThreadMetadata(threadId, metadata)
    );
    const refusal = new Error('This host has no live thread workspace binding capability');
    const host: AssistantThreadHostCapability = {
      createThread: vi.fn(async (resourceId: string) => ({
        createdAt: new Date('2026-10-08T00:00:00Z'),
        id: 'host-thread-1',
        resourceId,
        title: 'New Thread',
        updatedAt: new Date('2026-10-08T00:00:00Z'),
      })),
      deleteThread: vi.fn(),
      listThreads: vi.fn(),
      ownsThread: vi.fn(async (threadId: string) => threadId === 'host-thread-1'),
      renameThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(async () => {
        throw refusal;
      }),
      workspaceRepository: (repository) => repository,
    };
    const wrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(AssistantThreadHostContext.Provider, { value: host }, children);
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper });

    result.current?.({ displayName: 'brainstrike', path: '/repo', rootId: 'root-1' });

    await waitFor(() => expect(toastMock).toHaveBeenCalledOnce());
    expect(host.createThread).toHaveBeenCalledExactlyOnceWith('workspace-memory');
    expect(history.createThread).not.toHaveBeenCalled();
    expect(history.updateThreadMetadata).not.toHaveBeenCalled();
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'destructive' });
    expect(String(toastMock.mock.calls[0]?.[0]?.description)).toContain(refusal.message);
  });

  it('surfaces a rejected thread creation without writing metadata', async () => {
    createThreadMock.mockRejectedValueOnce(new Error('create unavailable'));
    const { result } = renderHook(() => useCreateThreadInFolder());

    result.current?.({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledExactlyOnceWith({
        description: 'create unavailable',
        title: 'New thread in brainstrike failed',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadataMock).not.toHaveBeenCalled();
  });

  it('returns null without creating a repository while the database is unavailable', () => {
    usePGliteDatabaseMock.mockReturnValue(null);

    const { result } = renderHook(() => useCreateThreadInFolder());

    expect(result.current).toBeNull();
    expect(createPgliteAssistantThreadRepositoryMock).not.toHaveBeenCalled();
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(updateThreadMetadataMock).not.toHaveBeenCalled();
  });
});
