import { INTERNAL_FAULT, refusalError } from '@brainstrike/assistant-contract/boundary-failure';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { useCreateThreadInFolder } from '../hooks/use-create-thread-in-folder';

const { createThreadMock, toastMock, updateThreadMetadataMock, useAssistantThreadStoreMock } =
  vi.hoisted(() => {
    const createThread = vi.fn();
    const updateThreadMetadata = vi.fn();
    return {
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
    };
  });

vi.mock('@brainstrike/assistant-data', () => ({
  useAssistantThreadStore: useAssistantThreadStoreMock,
  WORKSPACE_MEMORY_RESOURCE_ID: 'workspace-memory',
}));

vi.mock('@brainstrike/ui', () => ({ toast: toastMock }));

describe('useCreateThreadInFolder', () => {
  // The repository the host-owned catalog builds around the attached host.
  const repository = expect.objectContaining({
    createThread: expect.any(Function),
    updateThreadMetadata: expect.any(Function),
  });
  const host: AssistantThreadHostCapability = {
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    listThreads: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    createThreadMock.mockResolvedValue({ id: 'thread-1' });
    updateThreadMetadataMock.mockResolvedValue(undefined);
  });

  it('creates one thread before writing the complete operating-root binding once', async () => {
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper });

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
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper });

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
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper });

    result.current?.({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledExactlyOnceWith({
        description: `Could not bind it to brainstrike. Open the thread and select brainstrike to retry. Error: ${INTERNAL_FAULT.message}`,
        title: 'Thread created in No folder',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadataMock).toHaveBeenCalledOnce();
  });

  it('creates through the host and reports a refused host binding', async () => {
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
    const refusal = refusalError(
      'availability',
      'workspace.binding-unavailable',
      'The folder binding is unavailable.',
      'Reconnect the folder.'
    );
    const refusingHost: AssistantThreadHostCapability = {
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
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    const refusingWrapper = ({ children }: { readonly children: ReactNode }) =>
      createElement(AssistantThreadHostContext.Provider, { value: refusingHost }, children);
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper: refusingWrapper });

    result.current?.({ displayName: 'brainstrike', path: '/repo', rootId: 'root-1' });

    await waitFor(() => expect(toastMock).toHaveBeenCalledOnce());
    expect(refusingHost.createThread).toHaveBeenCalledExactlyOnceWith('workspace-memory');
    expect(toastMock.mock.calls[0]?.[0]).toMatchObject({ variant: 'destructive' });
    expect(String(toastMock.mock.calls[0]?.[0]?.description)).toContain(refusal.message);
    expect(String(toastMock.mock.calls[0]?.[0]?.description)).toContain('Reconnect the folder.');
  });

  it('surfaces a rejected thread creation without writing metadata', async () => {
    createThreadMock.mockRejectedValueOnce(new Error('create unavailable'));
    const { result } = renderHook(() => useCreateThreadInFolder(), { wrapper });

    result.current?.({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledExactlyOnceWith({
        description: INTERNAL_FAULT.message,
        title: 'New thread in brainstrike failed',
        variant: 'destructive',
      })
    );
    expect(updateThreadMetadataMock).not.toHaveBeenCalled();
  });

  it('returns null while no agent host is attached', () => {
    const { result } = renderHook(() => useCreateThreadInFolder());

    expect(result.current).toBeNull();
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(updateThreadMetadataMock).not.toHaveBeenCalled();
  });
});
