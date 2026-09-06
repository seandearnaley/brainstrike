import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
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
    const query = vi.fn(async () => ({ rows: [{ id: 'current-main-root' }] }));
    const database = { query } as unknown as DbHandle;
    const updateThreadMetadata = vi.fn(async () => {});
    const repository = { updateThreadMetadata } as unknown as AssistantThreadRepository;
    const { result } = renderHook(() =>
      useAssistantThreadRootBinding({
        assistantThreadRepository: repository,
        currentMainRoot: {
          displayName: 'Current Main',
          path: '/workspace/current-main',
        },
        database,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );

    await expect(result.current.resolveThreadRootBinding()).rejects.toThrow(
      'Cannot resolve the assistant thread root before the selected thread metadata is loaded.'
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
    expect(query).not.toHaveBeenCalled();
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('exposes operatingRoot for a single-root workspace (the bar is always visible)', () => {
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
        assistantThreadRepository: {
          updateThreadMetadata: vi.fn(async () => {}),
        } as unknown as AssistantThreadRepository,
        currentMainRoot: { displayName: 'Only', path: '/ws/only' },
        database: { query: vi.fn() } as unknown as DbHandle,
        memoryResourceId: RESOURCE_ID,
        selectedMemoryThreadId: THREAD_ID,
      })
    );
    expect(result.current.operatingRoot).toEqual({ displayName: 'Only', path: '/ws/only' });
  });
});
