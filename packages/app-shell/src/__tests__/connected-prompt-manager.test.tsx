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

const mocks = vi.hoisted(() => ({
  createThread: vi.fn(),
  db: { exec: vi.fn(), query: vi.fn() },
  embedDocumentWithRecovery: vi.fn(),
  embedPendingPromptItems: vi.fn(),
  embedQueryWithRecovery: vi.fn(),
  importLegacyPromptStore: vi.fn(),
  queryPromptSuggestions: vi.fn(),
  recordUsage: vi.fn(),
  renameThread: vi.fn(),
}));

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
  useSharedSearchEmbedder: () => ({
    embedDocumentWithRecovery: mocks.embedDocumentWithRecovery,
    embedQueryWithRecovery: mocks.embedQueryWithRecovery,
  }),
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
    modelOptions: Array<{ key: string; label: string }>;
    onRequestSuggestions: (context: string) => Promise<unknown>;
    onUseItem: (
      item: PromptItem,
      content: string,
      action: 'insert' | 'new-thread'
    ) => Promise<void>;
  }) => (
    <div data-testid="prompt-workbench-panel">
      <span data-testid="active-thread-id">{props.activeThreadId}</span>
      <span data-testid="composer-context">{props.composerContext}</span>
      <span data-testid="model-options">{JSON.stringify(props.modelOptions)}</span>
      <button onClick={() => props.onUseItem(testItem, testItem.content, 'insert')} type="button">
        Insert test item
      </button>
      <button
        onClick={() => props.onUseItem(testItem, testItem.content, 'new-thread')}
        type="button"
      >
        New thread from test item
      </button>
      <button onClick={() => props.onRequestSuggestions('Live draft')} type="button">
        Recall suggestions
      </button>
    </div>
  ),
}));

describe('ConnectedPromptManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importLegacyPromptStore.mockResolvedValue({ imported: 0 });
    mocks.embedPendingPromptItems.mockResolvedValue([]);
    mocks.queryPromptSuggestions.mockResolvedValue([]);
    mocks.recordUsage.mockResolvedValue(testItem);
    mocks.createThread.mockResolvedValue({
      createdAt: new Date('2026-07-10T12:00:00Z'),
      id: 'thread-new',
      resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
      title: 'New Thread',
      updatedAt: new Date('2026-07-10T12:00:00Z'),
    });
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
    render(<ConnectedPromptManager />);

    expect(screen.getByText('Opening Prompt Workbench…')).toBeInTheDocument();
    expect(await screen.findByTestId('prompt-workbench-panel')).toBeInTheDocument();
    expect(mocks.importLegacyPromptStore).toHaveBeenCalledWith(
      expect.objectContaining({ recordUsage: mocks.recordUsage })
    );
    expect(screen.getByTestId('active-thread-id')).toHaveTextContent('thread-active');
    expect(screen.getByTestId('composer-context')).toHaveTextContent('Live draft');
    expect(screen.getByTestId('model-options')).toHaveTextContent('openai::gpt-5.4');
    await waitFor(() => expect(mocks.embedPendingPromptItems).toHaveBeenCalled());
  });

  it('stages insertions into the active thread rather than the selected sidebar thread', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager />);
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

  it('creates, names, configures, and activates a new thread before staging the prompt', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager />);
    await user.click(await screen.findByRole('button', { name: 'New thread from test item' }));

    await waitFor(() =>
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-new',
      })
    );
    expect(mocks.renameThread).toHaveBeenCalledWith('thread-new', testItem.title);
    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-new']).toMatchObject({
      model: 'gpt-5.4',
      provider: 'openai',
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-new']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
    expect(mocks.recordUsage).toHaveBeenCalledWith(testItem.id, 'new-thread');
  });

  it('routes contextual recall through query embeddings without a lexical substitute', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager />);
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
});
