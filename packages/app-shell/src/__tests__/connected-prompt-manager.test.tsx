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
    assistantProviderSettings: {
      google: {
        googleIncludeThoughts: true,
        googleThinkingLevel: 'high' as const,
        maxOutputTokens: 768,
      } as {
        googleIncludeThoughts?: boolean;
        googleThinkingLevel?: 'high';
        maxOutputTokens?: number;
      },
    },
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
    recallRequest: null as Promise<unknown> | null,
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
    selector: (state: {
      getAvailableProviders: typeof mocks.getAvailableProviders;
      providerSettings: typeof mocks.assistantProviderSettings;
    }) => unknown
  ) =>
    selector({
      getAvailableProviders: mocks.getAvailableProviders,
      providerSettings: mocks.assistantProviderSettings,
    }),
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
      capabilities: { type: 'llm' },
      id: 'gemini-3.1-pro-preview',
      isEnabled: true,
      name: 'Gemini 3.1 Pro',
      providerId: 'google',
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
    { id: 'google', isEnabled: true, name: 'Google' },
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
    suggestionsEnabled?: boolean;
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
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelKey: 'google::gemini-3.1-pro-preview',
                modelSettings: {
                  frequencyPenalty: -1.5,
                  maxTokens: 1536,
                  model: 'gpt-5.4',
                  presencePenalty: 1.75,
                  temperature: 1.5,
                },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose configured prompt
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelKey: 'google::gemini-3.1-pro-preview',
                modelSettings: { model: 'gpt-5.4' },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose model-only configured prompt
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelSettings: {
                  maxOutputTokens: 2048,
                  temperature: 0.2,
                  topP: 0.85,
                },
              },
              testItem.content,
              'new-thread'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        New thread from configured prompt
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelSettings: { maxOutputTokens: 'many' },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose invalid configured prompt
      </button>
      {[
        ['max tokens zero', { maxTokens: 0 }],
        ['fractional max output tokens', { maxOutputTokens: 1.5 }],
        ['temperature below range', { temperature: -0.1 }],
        ['temperature above range', { temperature: 2.1 }],
        ['top p below range', { topP: -0.1 }],
        ['top p above range', { topP: 1.1 }],
        ['frequency penalty below range', { frequencyPenalty: -2.1 }],
        ['presence penalty above range', { presencePenalty: 2.1 }],
      ].map(([label, modelSettings]) => (
        <button
          key={String(label)}
          onClick={() => {
            void props
              .onUseItem(
                {
                  ...testItem,
                  kind: 'prompt',
                  modelSettings: modelSettings as Record<string, unknown>,
                },
                testItem.content,
                'compose'
              )
              .catch(mocks.onUseError);
          }}
          type="button"
        >
          {`Compose prompt with ${String(label)}`}
        </button>
      ))}
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelSettings: { temperature: 2.1 },
              },
              testItem.content,
              'new-thread'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        New thread from invalid configured prompt
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelSettings: { seed: 42 },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose prompt with unknown settings
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelSettings: { maxOutputTokens: 1024, maxTokens: 512 },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose prompt with conflicting aliases
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem(
              {
                ...testItem,
                kind: 'prompt',
                modelKey: null,
                modelSettings: { temperature: 0.25 },
              },
              testItem.content,
              'compose'
            )
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose settings without model
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem({ ...testItem, kind: 'prompt' }, '   \n', 'compose')
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        Compose whitespace prompt
      </button>
      <button
        onClick={() => {
          void props
            .onUseItem({ ...testItem, kind: 'prompt' }, '   \n', 'new-thread')
            .catch(mocks.onUseError);
        }}
        type="button"
      >
        New thread from whitespace prompt
      </button>
      <button
        onClick={() => {
          const request = props.onRequestSuggestions('Live draft');
          mocks.recallRequest = request;
          void request.catch(mocks.onLibraryError);
        }}
        type="button"
      >
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
    mocks.assistantProviderSettings.google = {
      googleIncludeThoughts: true,
      googleThinkingLevel: 'high',
      maxOutputTokens: 768,
    };
    mocks.importLegacyPromptStore.mockResolvedValue({ imported: 0 });
    mocks.getAvailableProviders.mockResolvedValue(['google', 'openai']);
    mocks.loadEmbeddingQueue.mockResolvedValue({ id: 'prompt-embedding-queue' });
    mocks.embedPendingPromptItems.mockResolvedValue([]);
    mocks.queryPromptSuggestions.mockResolvedValue([]);
    mocks.recordUsage.mockResolvedValue(testItem);
    mocks.recallRequest = null;
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

  it('preserves the active thread runtime while applying every standard prompt model setting', async () => {
    const user = userEvent.setup();
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-active', {
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 512, topP: 0.7 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high' } },
      providerSettings: {
        openai: { maxOutputTokens: 512, reasoningEffort: 'high' },
      },
      runtimeKind: 'hosted',
    });
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(await screen.findByRole('button', { name: 'Compose configured prompt' }));

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']).toEqual({
      model: 'gemini-3.1-pro-preview',
      modelSettings: {
        frequencyPenalty: -1.5,
        maxOutputTokens: 1536,
        presencePenalty: 1.75,
        temperature: 1.5,
      },
      provider: 'google',
      providerOptions: {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'high',
          },
        },
        openai: { reasoningEffort: 'high' },
      },
      providerSettings: {
        google: {
          googleIncludeThoughts: true,
          googleThinkingLevel: 'high',
          maxOutputTokens: 768,
        },
        openai: { maxOutputTokens: 512, reasoningEffort: 'high' },
      },
      runtimeKind: 'hosted',
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
  });

  it('applies canonical prompt model settings to a newly created thread', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(
      await screen.findByRole('button', { name: 'New thread from configured prompt' })
    );

    await waitFor(() =>
      expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-new']).toEqual({
        model: 'gpt-5.4',
        modelSettings: { maxOutputTokens: 2048, temperature: 0.2, topP: 0.85 },
        provider: 'openai',
      })
    );
  });

  it('keeps same-provider thread model settings unless the prompt explicitly overrides them', async () => {
    const user = userEvent.setup();
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-active', {
      model: 'gemini-3.1-pro-preview',
      modelSettings: { maxOutputTokens: 512, topP: 0.7 },
      provider: 'google',
      providerSettings: {
        google: {
          googleIncludeThoughts: true,
          googleThinkingLevel: 'high',
        },
      },
    });
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(
      await screen.findByRole('button', { name: 'Compose model-only configured prompt' })
    );

    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']?.modelSettings
    ).toEqual({ maxOutputTokens: 512, topP: 0.7 });

    await user.click(screen.getByRole('button', { name: 'Compose configured prompt' }));

    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']?.modelSettings
    ).toEqual({
      frequencyPenalty: -1.5,
      maxOutputTokens: 1536,
      presencePenalty: 1.75,
      temperature: 1.5,
      topP: 0.7,
    });
  });

  it('drops old-provider model settings when the target provider has none', async () => {
    const user = userEvent.setup();
    mocks.assistantProviderSettings.google = {
      googleIncludeThoughts: true,
      googleThinkingLevel: 'high',
    };
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-active', {
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 512, topP: 0.7 },
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high' } },
      providerSettings: {
        openai: { maxOutputTokens: 512, reasoningEffort: 'high' },
      },
    });
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(
      await screen.findByRole('button', { name: 'Compose model-only configured prompt' })
    );

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']).toEqual({
      model: 'gemini-3.1-pro-preview',
      provider: 'google',
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
        openai: { reasoningEffort: 'high' },
      },
      providerSettings: {
        google: { googleIncludeThoughts: true, googleThinkingLevel: 'high' },
        openai: { maxOutputTokens: 512, reasoningEffort: 'high' },
      },
    });
  });

  it.each([
    ['Compose invalid configured prompt', /maxOutputTokens.*number/i],
    ['Compose prompt with unknown settings', /unsupported model settings.*seed/i],
    ['Compose prompt with conflicting aliases', /both.*maxTokens.*maxOutputTokens/i],
    ['Compose settings without model', /model settings.*configured model/i],
  ])('rejects %s before mutating the runtime or composer', async (buttonName, expectedMessage) => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(await screen.findByRole('button', { name: buttonName }));

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(expectedMessage) })
      )
    );
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']
    ).toBeUndefined();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['max tokens zero', /maxTokens.*positive integer/i],
    ['fractional max output tokens', /maxOutputTokens.*positive integer/i],
    ['temperature below range', /temperature.*between 0 and 2/i],
    ['temperature above range', /temperature.*between 0 and 2/i],
    ['top p below range', /topP.*between 0 and 1/i],
    ['top p above range', /topP.*between 0 and 1/i],
    ['frequency penalty below range', /frequencyPenalty.*between -2 and 2/i],
    ['presence penalty above range', /presencePenalty.*between -2 and 2/i],
  ])('rejects %s before any compose mutation', async (settingLabel, expectedMessage) => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(
      await screen.findByRole('button', { name: `Compose prompt with ${settingLabel}` })
    );

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(expectedMessage) })
      )
    );
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']
    ).toBeUndefined();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects invalid model settings before creating a durable thread', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);

    await user.click(
      await screen.findByRole('button', { name: 'New thread from invalid configured prompt' })
    );

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/temperature.*between 0 and 2/i) })
      )
    );
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-new']).toBeUndefined();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-new']
    ).toBeUndefined();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only rendered prompts before mutating the active thread runtime', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(await screen.findByRole('button', { name: 'Compose whitespace prompt' }));

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/non-whitespace/i) })
      )
    );
    expect(
      useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-active']
    ).toBeUndefined();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-active']
    ).toBeUndefined();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only rendered prompts before creating a durable thread', async () => {
    const user = userEvent.setup();
    render(<ConnectedPromptManager loadEmbeddingQueue={mocks.loadEmbeddingQueue} />);
    await user.click(
      await screen.findByRole('button', { name: 'New thread from whitespace prompt' })
    );

    await waitFor(() =>
      expect(mocks.onUseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringMatching(/non-whitespace/i) })
      )
    );
    expect(mocks.createThread).not.toHaveBeenCalled();
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-new']
    ).toBeUndefined();
    expect(mocks.recordUsage).not.toHaveBeenCalled();
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

  it('does not start query inference when recall is disabled while prerequisites load', async () => {
    const user = userEvent.setup();
    let resolveQueue!: (queue: { id: string }) => void;
    const queueReady = new Promise<{ id: string }>((resolve) => {
      resolveQueue = resolve;
    });
    mocks.loadEmbeddingQueue.mockReturnValue(queueReady);
    mocks.embedQueryWithRecovery.mockResolvedValue([0.1, 0.2]);
    mocks.queryPromptSuggestions.mockImplementation(
      async ({ context, embedder, modelInfo, signal }) => {
        signal.throwIfAborted();
        await embedder.embedQueryWithRecovery(modelInfo, context);
        return [];
      }
    );
    const renderManager = (suggestionsEnabled: boolean) => (
      <ConnectedPromptManager
        loadEmbeddingQueue={mocks.loadEmbeddingQueue}
        suggestionsEnabled={suggestionsEnabled}
      />
    );
    const view = render(renderManager(true));

    await user.click(await screen.findByRole('button', { name: 'Recall suggestions' }));
    await waitFor(() => expect(mocks.loadEmbeddingQueue).toHaveBeenCalledTimes(2));
    view.rerender(renderManager(false));

    resolveQueue({ id: 'prompt-embedding-queue' });
    await mocks.recallRequest?.catch(() => undefined);

    expect(mocks.embedQueryWithRecovery).not.toHaveBeenCalled();
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
