import '@testing-library/jest-dom/vitest';
import type { PromptItem } from '@brainstrike/db';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '../assistant-memory-resource';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { ConnectedPromptManager } from '../connected-prompt-manager';

const testItem: PromptItem = {
  archivedAt: null,
  content: 'Use exact evidence.',
  createdAt: new Date('2026-07-10T12:00:00Z'),
  description: null,
  embeddingError: null,
  embeddingProfileId: 'default',
  embeddingRevision: 1,
  embeddingStatus: 'ready',
  embeddingUpdatedAt: new Date('2026-07-10T12:00:00Z'),
  id: 'prompt-1',
  isFavorite: false,
  kind: 'snippet',
  lastUsedAction: null,
  lastUsedAt: null,
  modelKey: 'openai::gpt-5.4',
  modelSettings: null,
  rating: null,
  revision: 1,
  sourceUrl: null,
  tags: [],
  title: 'Evidence rule',
  updatedAt: new Date('2026-07-10T12:00:00Z'),
  useCount: 0,
};

const mocks = vi.hoisted(() => {
  const embedDocumentWithRecovery = vi.fn();
  const embedQueryWithRecovery = vi.fn();
  return {
    createThread: vi.fn(),
    db: { exec: vi.fn(), query: vi.fn() },
    embedDocumentWithRecovery,
    embedPendingPromptItems: vi.fn(),
    embedQueryWithRecovery,
    getAvailableProviders: vi.fn(),
    importLegacyPromptStore: vi.fn(),
    loadEmbeddingQueue: vi.fn(),
    onLibraryError: vi.fn(),
    onUseError: vi.fn(),
    queryPromptSuggestions: vi.fn(),
    recordUsage: vi.fn(),
    renameThread: vi.fn(),
    sharedEmbedder: { embedDocumentWithRecovery, embedQueryWithRecovery },
  };
});

const repository = {
  create: vi.fn(),
  getEmbeddingProfile: vi.fn().mockResolvedValue({
    dimensions: 384,
    distance: 'cosine',
    id: 'default',
    modelId: 'Xenova/all-MiniLM-L6-v2',
    modelKey: 'local::Xenova/all-MiniLM-L6-v2',
  }),
  importSnapshot: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  listNeedingEmbedding: vi.fn().mockResolvedValue([]),
  markEmbeddingError: vi.fn(),
  recordUsage: mocks.recordUsage,
  searchSimilar: vi.fn(),
  storeEmbedding: vi.fn(),
  update: vi.fn(),
};

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db');
  return {
    ...actual,
    PromptItemRepository: class {
      create = repository.create;
      getEmbeddingProfile = repository.getEmbeddingProfile;
      importSnapshot = repository.importSnapshot;
      list = repository.list;
      listNeedingEmbedding = repository.listNeedingEmbedding;
      markEmbeddingError = repository.markEmbeddingError;
      recordUsage = repository.recordUsage;
      searchSimilar = repository.searchSimilar;
      storeEmbedding = repository.storeEmbedding;
      update = repository.update;
    },
    usePGliteDatabase: () => mocks.db,
  };
});

vi.mock('@brainstrike/db-explorer/embedding-models', () => ({
  buildLocalEmbeddingModelConfigMap: () =>
    new Map([['Xenova/all-MiniLM-L6-v2', { dimensions: 384, id: 'Xenova/all-MiniLM-L6-v2' }]]),
  resolveEmbeddingSetModelInfo: () => ({
    dimensions: 384,
    modelConfig: { dimensions: 384, id: 'Xenova/all-MiniLM-L6-v2' },
    modelKey: 'Xenova/all-MiniLM-L6-v2',
  }),
}));

vi.mock('@brainstrike/preferences/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/preferences/stores/assistant-preferences-store', () => ({
  useAssistantPreferencesStore: (
    selector: (state: { getAvailableProviders: typeof mocks.getAvailableProviders }) => unknown
  ) => selector({ getAvailableProviders: mocks.getAvailableProviders }),
}));

const registryState = {
  models: [
    {
      capabilities: { type: 'llm' },
      id: 'gpt-5.4',
      isEnabled: true,
      name: 'GPT-5.4',
      providerId: 'openai',
    },
    {
      capabilities: { defaultDimension: 384, type: 'embedding' },
      id: 'Xenova/all-MiniLM-L6-v2',
      isEnabled: true,
      name: 'MiniLM',
      providerId: 'transformers',
    },
  ],
  providers: [
    { id: 'openai', isEnabled: true, name: 'OpenAI' },
    { id: 'transformers', isEnabled: true, name: 'Local' },
  ],
};

vi.mock('@brainstrike/preferences/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector?: (state: typeof registryState) => unknown) =>
    selector ? selector(registryState) : registryState,
}));

vi.mock('@brainstrike/vector-management', () => ({
  useSharedSearchEmbedder: () => mocks.sharedEmbedder,
}));

vi.mock('../assistant-memory-repository', () => ({
  createPgliteAssistantThreadRepository: () => ({
    createThread: mocks.createThread,
    renameThread: mocks.renameThread,
  }),
}));

vi.mock('../prompt-library-legacy-import', () => ({
  importLegacyPromptStore: mocks.importLegacyPromptStore,
}));

vi.mock('../prompt-library-embedding', () => ({
  embedPendingPromptItems: mocks.embedPendingPromptItems,
  queryPromptSuggestions: mocks.queryPromptSuggestions,
}));

vi.mock('../prompt-workbench-panel', () => ({
  PromptWorkbenchPanel: (props: {
    activeThreadId?: string;
    composerContext: string;
    initialItems: readonly PromptItem[];
    modelOptions: Array<{ key: string; label: string }>;
    onLibraryChanged: () => Promise<void>;
    onRequestSuggestions: (context: string) => Promise<unknown>;
    onUseItem: (
      item: PromptItem,
      content: string,
      action: 'compose' | 'insert' | 'new-thread'
    ) => Promise<void>;
    systemError?: string;
  }) => (
    <div data-testid="prompt-workbench-panel">
      <span data-testid="active-thread-id">{props.activeThreadId}</span>
      <span data-testid="composer-context">{props.composerContext}</span>
      <span data-testid="first-item-embedding-status">
        {props.initialItems[0]?.embeddingStatus}
      </span>
      <span data-testid="model-options">{JSON.stringify(props.modelOptions)}</span>
      <span data-testid="system-error">{props.systemError}</span>
      <button
        onClick={() => {
          void props.onUseItem(testItem, testItem.content, 'insert').catch(mocks.onUseError);
        }}
        type="button"
      >
        Insert test item
      </button>
      <button
        onClick={() => props.onUseItem(testItem, testItem.content, 'new-thread')}
        type="button"
      >
        New thread from test item
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem({ ...testItem, kind: 'prompt' }, testItem.content, 'compose')
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose test prompt
      </button>
      <button onClick={() => props.onRequestSuggestions('Live draft')} type="button">
        Recall suggestions
      </button>
      <button
        onClick={() => {
          void props.onLibraryChanged().catch(mocks.onLibraryError);
        }}
        type="button"
      >
        Retry indexing
      </button>
    </div>
  ),
}));

describe('ConnectedPromptManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importLegacyPromptStore.mockResolvedValue({ imported: 0 });
    mocks.getAvailableProviders.mockResolvedValue(['openai']);
    mocks.loadEmbeddingQueue.mockResolvedValue({ id: 'prompt-embedding-queue' });
    mocks.embedPendingPromptItems.mockResolvedValue([]);
    mocks.queryPromptSuggestions.mockResolvedValue([]);
    mocks.recordUsage.mockResolvedValue(testItem);
    repository.list.mockReset().mockResolvedValue([]);
    mocks.createThread.mockImplementation(async (resourceId: string, title = 'New Thread') => ({
      createdAt: new Date('2026-07-10T12:00:00Z'),
      id: 'thread-new',
      resourceId,
      title,
      updatedAt: new Date('2026-07-10T12:00:00Z'),
    }));
    mocks.renameThread.mockResolvedValue(undefined);
    useAssistantComposerCommandStore.getState().reset();
    useAssistantComposerCommandStore.getState().recordDraft('thread-active', 'Live draft');
    useAssistantThreadStore.setState({
      activeThreadIdByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-active' },
      draftRuntimeByThreadId: {},
      loadStateByResourceId: {},
      openThreadIdsByResourceId: {
        [WORKSPACE_MEMORY_RESOURCE_ID]: ['thread-active', 'thread-selected'],
      },
      selectedThreadByResourceId: { [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-selected' },
      threadIdsByResourceId: {
        [WORKSPACE_MEMORY_RESOURCE_ID]: ['thread-active', 'thread-selected'],
      },
      threadsByResourceId: {},
    });
  });

  it('imports before rendering and projects the active thread, live draft, and enabled LLMs', async () => {
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    expect(screen.getByText('Opening Prompt Workbench…')).toBeInTheDocument();
    expect(await screen.findByTestId('prompt-workbench-panel')).toBeInTheDocument();
    expect(mocks.importLegacyPromptStore).toHaveBeenCalledWith(
      expect.objectContaining({ recordUsage: mocks.recordUsage })
    );
    expect(screen.getByTestId('active-thread-id')).toHaveTextContent('thread-active');
    expect(screen.getByTestId('composer-context')).toHaveTextContent('Live draft');
    expect(screen.getByTestId('model-options')).toHaveTextContent('openai::gpt-5.4');
    await waitFor(() => expect(mocks.embedPendingPromptItems).toHaveBeenCalled());
    expect(mocks.loadEmbeddingQueue).toHaveBeenCalled();
    expect(mocks.loadEmbeddingQueue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.embedPendingPromptItems.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('stages insertions into the active thread rather than the selected sidebar thread', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'Insert test item' }));

    await waitFor(() =>
      expect(
        useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']?.[0]
      ).toMatchObject({ mode: 'append', text: testItem.content, threadId: 'thread-active' })
    );
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-selected']
    ).toBeUndefined();
    expect(mocks.recordUsage).toHaveBeenCalledWith(testItem.id, 'insert');
  });

  it('keeps an applied composer command successful when usage tracking fails', async () => {
    const user = userEvent.setup();
    mocks.recordUsage.mockRejectedValueOnce(new Error('Usage counter is unavailable.'));
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(await screen.findByRole('button', { name: 'Insert test item' }));

    await waitFor(() =>
      expect(
        useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
      ).toHaveLength(1)
    );
    expect(mocks.onUseError).not.toHaveBeenCalled();
    expect(screen.getByTestId('system-error')).toHaveTextContent(/prompt was staged/i);
    expect(screen.getByTestId('system-error')).toHaveTextContent(/usage tracking failed/i);
    expect(screen.getByTestId('system-error')).toHaveTextContent('Usage counter is unavailable.');

    mocks.recordUsage.mockResolvedValue(testItem);
    await user.click(screen.getByRole('button', { name: 'Insert test item' }));

    await waitFor(() => expect(screen.getByTestId('system-error')).toBeEmptyDOMElement());
    expect(mocks.onUseError).not.toHaveBeenCalled();
  });

  it('atomically creates a titled thread, configures it, and stages the prompt', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'New thread from test item' }));

    await waitFor(() =>
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-new',
      })
    );
    expect(mocks.createThread).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID, testItem.title);
    expect(mocks.renameThread).not.toHaveBeenCalled();
    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-new']).toMatchObject({
      model: 'gpt-5.4',
      provider: 'openai',
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-new']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
    expect(mocks.recordUsage).toHaveBeenCalledWith(testItem.id, 'new-thread');
  });

  it('applies a runnable prompt model to the active thread before staging it', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'Compose test prompt' }));

    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']
    ).toMatchObject({
      model: 'gpt-5.4',
      provider: 'openai',
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
    expect(mocks.recordUsage).toHaveBeenCalledWith(testItem.id, 'compose');
  });

  it('refuses to stage a prompt whose requested provider is unavailable', async () => {
    const user = userEvent.setup();
    mocks.getAvailableProviders.mockResolvedValue(['local']);
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'Compose test prompt' }));

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/openai.*not available/i) })
      )
    );
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']
    ).toBeUndefined();
  });

  it('routes contextual recall through query embeddings without a lexical substitute', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'Recall suggestions' }));

    await waitFor(() =>
      expect(mocks.queryPromptSuggestions).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'Live draft',
          repository: expect.objectContaining({ recordUsage: mocks.recordUsage }),
        })
      )
    );
  });

  it('refreshes initially pending items after background indexing finishes', async () => {
    const pendingItem = {
      ...testItem,
      embeddingRevision: null,
      embeddingStatus: 'pending' as const,
      embeddingUpdatedAt: null,
    };
    repository.list.mockResolvedValueOnce([pendingItem]).mockResolvedValue([testItem]);

    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await waitFor(() =>
      expect(screen.getByTestId('first-item-embedding-status')).toHaveTextContent('ready')
    );
    expect(repository.list).toHaveBeenCalledTimes(2);
  });

  it('serializes overlapping indexing requests', async () => {
    const user = userEvent.setup();
    let resolveFirstPass!: (value: readonly never[]) => void;
    mocks.embedPendingPromptItems
      .mockImplementationOnce(
        () =>
          new Promise<readonly never[]>((resolve) => {
            resolveFirstPass = resolve;
          })
      )
      .mockResolvedValue([]);

    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await screen.findByTestId('prompt-workbench-panel');
    await waitFor(() => expect(mocks.embedPendingPromptItems).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Retry indexing' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.embedPendingPromptItems).toHaveBeenCalledTimes(1);

    resolveFirstPass([]);
    await waitFor(() => expect(mocks.embedPendingPromptItems).toHaveBeenCalledTimes(2));
  });

  it('surfaces an explicit initialization error when the post-index refresh fails', async () => {
    repository.list
      .mockResolvedValueOnce([{ ...testItem, embeddingStatus: 'pending' }])
      .mockRejectedValueOnce(new Error('Could not refresh indexed prompts.'));

    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh indexed prompts.'
    );
  });

  it('clears a stale indexing error after a later indexing pass succeeds', async () => {
    const user = userEvent.setup();
    mocks.embedPendingPromptItems.mockRejectedValue(new Error('Embedding worker unavailable.'));
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await waitFor(() =>
      expect(screen.getByTestId('system-error')).toHaveTextContent('Embedding worker unavailable.')
    );
    mocks.embedPendingPromptItems.mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'Retry indexing' }));

    await waitFor(() => expect(screen.getByTestId('system-error')).toBeEmptyDOMElement());
  });

  it('leaves explicit indexing failure ownership to the workbench warning', async () => {
    const user = userEvent.setup();
    mocks.embedPendingPromptItems.mockRejectedValue(new Error('Embedding worker unavailable.'));
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await waitFor(() =>
      expect(screen.getByTestId('system-error')).toHaveTextContent('Embedding worker unavailable.')
    );

    await user.click(screen.getByRole('button', { name: 'Retry indexing' }));

    await waitFor(() =>
      expect(mocks.onLibraryError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Embedding worker unavailable.' })
      )
    );
    expect(screen.getByTestId('system-error')).toBeEmptyDOMElement();
  });
});
