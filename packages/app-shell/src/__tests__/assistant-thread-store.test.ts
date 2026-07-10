import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMemoryThread,
  AssistantThreadRepository,
} from '../assistant-memory-repository';
import { useAssistantThreadStore } from '../assistant-thread-store';

const workspaceId = '/tmp/workspace-a';

function makeThread(id: string, updatedAt: string): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-04-22T09:00:00Z'),
    id,
    resourceId: workspaceId,
    title: id,
    updatedAt: new Date(updatedAt),
  };
}

function makeCuratedThread(): AssistantMemoryThread {
  return {
    createdAt: new Date('2026-04-22T09:00:00Z'),
    id: 'thread-curated',
    metadata: {
      color: 'blue',
      icon: 'message',
      model: 'gpt-5.2',
      provider: 'openai',
    },
    resourceId: workspaceId,
    title: 'Curated thread',
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
    createThread: vi.fn(async (resourceId: string, title = 'New Thread') => ({
      createdAt: new Date('2026-04-22T12:00:00Z'),
      id: 'thread-created',
      resourceId,
      title,
      updatedAt: new Date('2026-04-22T12:00:00Z'),
    })),
    createThreadRun: vi.fn(),
    deleteThread: vi.fn(),
    getCrossRootUsage: vi.fn(async () => []),
    getThreadCumulativeUsage: vi.fn(async () => null),
    listLatestThreadRuns: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listThreadRunEvents: vi.fn(async () => []),
    listThreads: vi.fn(async () => threads),
    recordRunUsage: vi.fn(),
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

  it('creates a durable titled thread in one repository operation', async () => {
    const repository = createRepository([]);

    const thread = await useAssistantThreadStore
      .getState()
      .createThread(repository, workspaceId, 'Evidence review');

    expect(repository.createThread).toHaveBeenCalledWith(workspaceId, 'Evidence review');
    expect(thread.title).toBe('Evidence review');
    expect(useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0]?.title).toBe(
      'Evidence review'
    );
  });

  it('waits for an in-flight initial load before creating and activating a titled thread', async () => {
    const repository = createRepository([]);
    let resolveInitialLoad!: (threads: readonly AssistantMemoryThread[]) => void;
    vi.mocked(repository.listThreads).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitialLoad = resolve;
        })
    );

    const initialLoad = useAssistantThreadStore
      .getState()
      .ensureResourceThreads(repository, workspaceId);
    const create = useAssistantThreadStore
      .getState()
      .createThread(repository, workspaceId, 'Evidence review');
    resolveInitialLoad([makeThread('thread-existing', '2026-04-22T11:00:00Z')]);
    await Promise.all([initialLoad, create]);

    const state = useAssistantThreadStore.getState();
    expect(state.threadsByResourceId[workspaceId]?.map((thread) => thread.id)).toEqual([
      'thread-created',
      'thread-existing',
    ]);
    expect(state.threadsByResourceId[workspaceId]?.[0]?.title).toBe('Evidence review');
    expect(state.activeThreadIdByResourceId[workspaceId]).toBe('thread-created');
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

  it('refreshes loaded thread titles set out-of-band (observer auto-title) without disturbing selection', async () => {
    const repository = createRepository();

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    useAssistantThreadStore.getState().openThreadTab(workspaceId, 'thread-b');

    // Simulate the observer renaming thread-a in the DB after the turn.
    (repository.listThreads as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { ...makeThread('thread-a', '2026-04-22T11:00:00Z'), title: 'Paris Weather Chat' },
      makeThread('thread-b', '2026-04-22T10:00:00Z'),
    ]);

    await useAssistantThreadStore.getState().refreshResourceThreads(repository, workspaceId);

    const state = useAssistantThreadStore.getState();
    expect(
      state.threadsByResourceId[workspaceId]?.find((thread) => thread.id === 'thread-a')?.title
    ).toBe('Paris Weather Chat');
    // Selection/open state is keyed by id and must be untouched by the refresh.
    expect(state.selectedThreadByResourceId[workspaceId]).toBe('thread-b');
  });

  it('does not refresh a resource whose initial load has not completed', async () => {
    const repository = createRepository();

    await useAssistantThreadStore.getState().refreshResourceThreads(repository, workspaceId);

    expect(repository.listThreads).not.toHaveBeenCalled();
    expect(useAssistantThreadStore.getState().threadsByResourceId[workspaceId]).toBeUndefined();
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

  it('does not let a redundant ready-state load overwrite a just-renamed thread', async () => {
    const repository = createRepository([]);
    let resolveStaleThreads: (threads: readonly AssistantMemoryThread[]) => void = () => undefined;
    vi.mocked(repository.listThreads).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStaleThreads = resolve;
        })
    );

    const created = await useAssistantThreadStore.getState().createThread(repository, workspaceId);
    const redundantLoad = useAssistantThreadStore
      .getState()
      .ensureResourceThreads(repository, workspaceId);
    await useAssistantThreadStore
      .getState()
      .renameThread(repository, workspaceId, created.id, 'Evidence review');
    resolveStaleThreads([{ ...created, title: 'New Thread' }]);
    await redundantLoad;

    expect(repository.listThreads).not.toHaveBeenCalled();
    expect(useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0]?.title).toBe(
      'Evidence review'
    );
  });

  it('keeps draft runtime config isolated per open thread', () => {
    const store = useAssistantThreadStore.getState();

    store.openThreadTab(workspaceId, 'thread-a');
    store.setThreadDraftRuntime('thread-a', {
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 512 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    store.openThreadTab(workspaceId, 'thread-b');
    store.setThreadDraftRuntime('thread-b', {
      model: 'claude-sonnet-4-6',
      modelSettings: { maxOutputTokens: 1024 },
      provider: 'anthropic',
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId).toEqual({
      'thread-a': {
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 512 },
        provider: 'openai',
        providerOptions: { openai: { reasoningEffort: 'high' } },
      },
      'thread-b': {
        model: 'claude-sonnet-4-6',
        modelSettings: { maxOutputTokens: 1024 },
        provider: 'anthropic',
      },
    });
  });

  it('saves curated metadata through the repository and updates the loaded thread', async () => {
    const repository = createRepository([makeCuratedThread()]);

    await useAssistantThreadStore.getState().ensureResourceThreads(repository, workspaceId);
    await useAssistantThreadStore
      .getState()
      .updateThreadMetadata(repository, workspaceId, 'thread-curated', {
        color: 'rose',
        icon: 'bug',
      });

    expect(repository.updateThreadMetadata).toHaveBeenCalledWith('thread-curated', {
      color: 'rose',
      icon: 'bug',
    });
    expect(
      useAssistantThreadStore.getState().threadsByResourceId[workspaceId]?.[0]?.metadata
    ).toEqual({
      color: 'rose',
      icon: 'bug',
      model: 'gpt-5.2',
      provider: 'openai',
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
      color: 'rose',
      icon: 'plan',
      model: 'gpt-5.2',
      provider: 'openai',
    });
  });
});
