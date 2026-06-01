import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMemoryThread,
  AssistantThreadRepository,
} from '../assistant-memory-repository';
import { useAssistantThreadStore } from '../assistant-thread-store';

const workspaceId = '/tmp/workspace-a';

function makeThread(id: string, updatedAt: string): AssistantMemoryThread {
  return {
    id,
    resourceId: workspaceId,
    title: id,
    createdAt: new Date('2026-04-22T09:00:00Z'),
    updatedAt: new Date(updatedAt),
  };
}

function makeCuratedThread(): AssistantMemoryThread {
  return {
    id: 'thread-curated',
    resourceId: workspaceId,
    title: 'Curated thread',
    metadata: {
      provider: 'openai',
      model: 'gpt-5.2',
      icon: 'message',
      color: 'blue',
    },
    createdAt: new Date('2026-04-22T09:00:00Z'),
    updatedAt: new Date('2026-04-22T10:00:00Z'),
  };
}

function createRepository(
  threads: readonly AssistantMemoryThread[] = [
    makeThread('thread-a', '2026-04-22T11:00:00Z'),
    makeThread('thread-b', '2026-04-22T10:00:00Z'),
  ]
): AssistantThreadRepository {
  return {
    appendThreadRunEvent: vi.fn(),
    completeThreadRun: vi.fn(),
    createThread: vi.fn(async (resourceId: string) => ({
      id: 'thread-created',
      resourceId,
      title: 'New Thread',
      createdAt: new Date('2026-04-22T12:00:00Z'),
      updatedAt: new Date('2026-04-22T12:00:00Z'),
    })),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    listLatestThreadRuns: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(async () => threads),
    renameThread: vi.fn(),
    updateThreadMetadata: vi.fn(),
  };
}

describe('useAssistantThreadStore tab sessions', () => {
  beforeEach(() => {
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: {},
      draftRuntimeByThreadId: {},
      loadStateByResourceId: {},
      openThreadIdsByResourceId: {},
      selectedThreadByResourceId: {},
      threadIdsByResourceId: {},
      threadsByResourceId: {},
    });
  });

  it('deduplicates concurrent resource thread loads', async () => {
    let resolveThreads!: (threads: readonly AssistantMemoryThread[]) => void;
    const listThreadsPromise = new Promise<readonly AssistantMemoryThread[]>((resolve) => {
      resolveThreads = resolve;
    });
    const repository = createRepository([]);
    vi.mocked(repository.listThreads).mockReturnValue(listThreadsPromise);

    const firstLoad = useAssistantThreadStore
      .getState()
      .ensureResourceThreads(repository, workspaceId);
    const secondLoad = useAssistantThreadStore
      .getState()
      .ensureResourceThreads(repository, workspaceId);

    expect(repository.listThreads).toHaveBeenCalledTimes(1);
    resolveThreads([makeThread('thread-a', '2026-04-22T11:00:00Z')]);
    await Promise.all([firstLoad, secondLoad]);

    expect(repository.createThread).not.toHaveBeenCalled();
    expect(useAssistantThreadStore.getState().threadIdsByResourceId[workspaceId]).toEqual([
      'thread-a',
    ]);
  });

  it('opens and focuses historical threads without replacing the durable thread list', async () => {
    const repository = createRepository();

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-b');
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-a');
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-b');

    const state = useAssistantThreadStore.getState();
    expect(state.threadIdsByResourceId[workspaceId]).toEqual(['thread-a', 'thread-b']);
    expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-a', 'thread-b']);
    expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-b');
    expect(state.selectedThreadByResourceId[workspaceId]).toBe('thread-b');
  });

  it('closes a tab without deleting the thread or its messages', async () => {
    const repository = createRepository();

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-a');
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-b');
    useAssistantThreadStore.getState().closeThreadTab(workspaceId, 'thread-b');

    const state = useAssistantThreadStore.getState();
    expect(repository.deleteThread).not.toHaveBeenCalled();
    expect(state.threadIdsByResourceId[workspaceId]).toEqual(['thread-a', 'thread-b']);
    expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-a']);
    expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-a');
  });

  it('deletes a durable thread and reconciles open tab state', async () => {
    const repository = createRepository();

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-a');
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-b');

    await useAssistantThreadStore.getState().deleteThread(repository, workspaceId, 'thread-b');

    expect(repository.deleteThread).toHaveBeenCalledWith('thread-b');
    const state = useAssistantThreadStore.getState();
    expect(state.threadIdsByResourceId[workspaceId]).toEqual(['thread-a']);
    expect(state.threadsByResourceId[workspaceId]?.map((thread) => thread.id)).toEqual([
      'thread-a',
    ]);
    expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-a']);
    expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-a');
    expect(state.selectedThreadByResourceId[workspaceId]).toBe('thread-a');
  });

  it('creates durable threads as focused open tabs', async () => {
    const repository = createRepository();

    const thread = await useAssistantThreadStore.getState().createThread(repository, workspaceId);

    expect(thread.id).toBe('thread-created');
    const state = useAssistantThreadStore.getState();
    expect(state.threadIdsByResourceId[workspaceId]).toEqual(['thread-created']);
    expect(state.openThreadIdsByResourceId[workspaceId]).toEqual(['thread-created']);
    expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-created');
  });

  it('keeps draft runtime config isolated per open thread', () => {
    const store = useAssistantThreadStore.getState();

    store.openThreadTab(workspaceId, 'thread-a');
    store.setThreadDraftRuntime('thread-a', {
      provider: 'openai',
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 512 },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    store.openThreadTab(workspaceId, 'thread-b');
    store.setThreadDraftRuntime('thread-b', {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelSettings: { maxOutputTokens: 1024 },
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId).toEqual({
      'thread-a': {
        provider: 'openai',
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 512 },
        providerOptions: { openai: { reasoningEffort: 'high' } },
      },
      'thread-b': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        modelSettings: { maxOutputTokens: 1024 },
      },
    });
  });

  it('saves curated metadata through the repository and updates the loaded thread', async () => {
    const repository = createRepository([makeCuratedThread()]);

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    await useAssistantThreadStore
      .getState()
      .updateThreadMetadata(repository, workspaceId, 'thread-curated', {
        icon: 'bug',
        color: 'rose',
      });

    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-curated', {
      icon: 'bug',
      color: 'rose',
    });
    expect(
      useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0]?.metadata
    ).toEqual({
      provider: 'openai',
      model: 'gpt-5.2',
      icon: 'bug',
      color: 'rose',
    });
  });

  it('merges saved metadata against the latest loaded thread state', async () => {
    const repository = createRepository([makeCuratedThread()]);
    let resolveMetadataUpdate!: () => void;
    vi.mocked(repository.updateThreadMetadata).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveMetadataUpdate = resolve;
        })
    );

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    const metadataUpdate = useAssistantThreadStore
      .getState()
      .updateThreadMetadata(repository, workspaceId, 'thread-curated', {
        color: 'rose',
      });

    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-curated', {
      color: 'rose',
    });
    useAssistantThreadStore.setState((state) => ({
      threadsByResourceId: {
        ...state.threadsByResourceId,
        [workspaceId]: (state.threadsByResourceId[workspaceId] ?? []).map((thread) =>
          thread.id === 'thread-curated'
            ? {
                ...thread,
                metadata: {
                  ...(thread.metadata ?? {}),
                  icon: 'plan',
                },
              }
            : thread
        ),
      },
    }));
    resolveMetadataUpdate();
    await metadataUpdate;

    expect(
      useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0]?.metadata
    ).toEqual({
      provider: 'openai',
      model: 'gpt-5.2',
      icon: 'plan',
      color: 'rose',
    });
  });
});
