import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantThreadRootBinding } from '../hooks/use-assistant-thread-root-binding';

const RESOURCE_ID = 'workspace-a';
const THREAD_ID = 'restored-thread';

describe('useAssistantThreadRootBinding', () => {
  beforeEach(() => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: {},
      draftRuntimeByThreadId: {},
      loadStateByResourceId: {
        [RESOURCE_ID]: { status: 'loading' },
      },
      openThreadIdsByResourceId: {
        [RESOURCE_ID]: [THREAD_ID],
      },
      selectedThreadByResourceId: {
        [RESOURCE_ID]: THREAD_ID,
      },
      threadIdsByResourceId: {},
      threadsByResourceId: {},
    });
  });

  it('does not rebind a restored thread before its persisted metadata loads', async () => {
    const updateThreadMetadata = vi.fn(async () => {});
    const repository = { updateThreadMetadata } as unknown as AssistantThreadRepository;
    const { result } = renderHook(() =>
      useAssistantThreadRootBinding({
        assistantThreadRepository: repository,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );

    await expect(
      result.current.persistThreadRootBinding({
        displayName: 'Current Main',
        path: '/workspace/current-main',
        rootId: 'current-main-root',
      })
    ).rejects.toThrow(
      'Cannot persist the assistant thread root before the selected thread metadata is loaded.'
    );
    expect(result.current.operatingRoot).toBeUndefined();
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it("exposes the thread's own persisted binding as its operatingRoot", () => {
    useAssistantThreadStore.setState({
      ...useAssistantThreadStore.getState(),
      threadsByResourceId: {
        [RESOURCE_ID]: [
          {
            createdAt: new Date(),
            id: THREAD_ID,
            metadata: {
              operatingRootDisplayName: 'Only',
              operatingRootId: 'only-root',
              operatingRootPath: '/ws/only',
            },
            resourceId: RESOURCE_ID,
            title: 't',
            updatedAt: new Date(),
          },
        ],
      },
    });
    const { result } = renderHook(() =>
      useAssistantThreadRootBinding({
        assistantThreadRepository: {
          updateThreadMetadata: vi.fn(async () => {}),
        } as unknown as AssistantThreadRepository,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );
    expect(result.current.operatingRoot).toEqual({ displayName: 'Only', path: '/ws/only' });
  });

  it('exposes no folder for an unbound thread', () => {
    useAssistantThreadStore.setState({
      ...useAssistantThreadStore.getState(),
      threadsByResourceId: {
        [RESOURCE_ID]: [
          {
            createdAt: new Date(),
            id: THREAD_ID,
            metadata: {},
            resourceId: RESOURCE_ID,
            title: 't',
            updatedAt: new Date(),
          },
        ],
      },
    });
    const { result } = renderHook(() =>
      useAssistantThreadRootBinding({
        assistantThreadRepository: null,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );
    expect(result.current.operatingRoot).toBeUndefined();
    expect(result.current.threadRootBinding).toBeUndefined();
  });
});
