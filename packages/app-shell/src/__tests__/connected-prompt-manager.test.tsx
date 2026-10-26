import '@testing-library/jest-dom/vitest';
import { useAssistantThreadStore, WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data';
import type { PromptItem } from '@brainstrike/types/prompt-item';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../assistant-thread-host-context';
import { ConnectedPromptManager } from '../connected-prompt-manager';

const testItem: PromptItem = {
  archivedAt: null,
  content: 'Use exact evidence.',
  createdAt: new Date('2026-07-10T12:00:00Z'),
  description: null,
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
  getAvailableProviders: vi.fn(),
  onUseError: vi.fn(),
  recordUsage: vi.fn(),
  useCapabilityRepository: false,
}));

const repository = {
  create: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  recordUsage: mocks.recordUsage,
  update: vi.fn(),
};

vi.mock('../prompt-library-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prompt-library-repository')>();
  return {
    ...actual,
    createPromptLibraryRepository: (
      ...args: Parameters<typeof actual.createPromptLibraryRepository>
    ) =>
      mocks.useCapabilityRepository ? actual.createPromptLibraryRepository(...args) : repository,
  };
});

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/app-state/stores/assistant-preferences-store', () => ({
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
      capabilities: { defaultDimension: 1536, type: 'embedding' },
      id: 'text-embedding-3-small',
      isEnabled: true,
      name: 'Text Embedding 3 Small',
      providerId: 'openai',
    },
  ],
  providers: [
    { id: 'google', isEnabled: true, name: 'Google' },
    { id: 'openai', isEnabled: true, name: 'OpenAI' },
  ],
};

vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: (selector?: (state: typeof registryState) => unknown) =>
    selector ? selector(registryState) : registryState,
}));

vi.mock('../prompt-workbench-panel', () => ({
  PromptWorkbenchPanel: (props: {
    activeThreadId?: string;
    initialItems: readonly PromptItem[];
    modelOptions: Array<{ key: string; label: string }>;
    onUseItem: (
      item: PromptItem,
      content: string,
      action: 'compose' | 'insert' | 'new-thread'
    ) => Promise<void>;
    systemError?: string;
  }) => (
    <div data-testid="prompt-workbench-panel">
      <span data-testid="active-thread-id">{props.activeThreadId}</span>
      <span data-testid="first-item-title">{props.initialItems[0]?.title}</span>
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
    </div>
  ),
}));

function defaultHost(): AssistantThreadHostCapability {
  return {
    createThread: (resourceId: string) => mocks.createThread(resourceId),
    deleteThread: vi.fn(),
    listThreads: vi.fn(async () => []),
    ownsThread: vi.fn(),
    renameThread: vi.fn(),
    renderThread: vi.fn(),
    updateThreadBinding: vi.fn(),
    workspaceRepository: () => {
      throw new Error('Unexpected workspace snapshot access in this fixture');
    },
  };
}

/** The manager as the desktop shell mounts it: a host owns the threads. */
function Manager() {
  const host = useMemo(defaultHost, []);
  return (
    <AssistantThreadHostContext.Provider value={host}>
      <ConnectedPromptManager />
    </AssistantThreadHostContext.Provider>
  );
}

describe('ConnectedPromptManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.useCapabilityRepository = false;
    Object.defineProperty(window, 'promptLibrary', {
      configurable: true,
      value: { request: vi.fn() },
    });
    mocks.assistantProviderSettings.google = {
      googleIncludeThoughts: true,
      googleThinkingLevel: 'high',
      maxOutputTokens: 768,
    };
    mocks.getAvailableProviders.mockResolvedValue(['google', 'openai']);
    mocks.recordUsage.mockResolvedValue(testItem);
    repository.list.mockReset().mockResolvedValue([]);
    mocks.createThread.mockImplementation(async (resourceId: string, title = 'New Thread') => ({
      createdAt: new Date('2026-07-10T12:00:00Z'),
      id: 'thread-new',
      resourceId,
      title,
      updatedAt: new Date('2026-07-10T12:00:00Z'),
    }));
    useAssistantComposerCommandStore.getState().reset();
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

  it('opens the native prompt capability', async () => {
    mocks.useCapabilityRepository = true;
    const request = vi.fn(async () => ({
      accepted: true,
      items: [],
      revisions: [],
    }));
    Object.defineProperty(window, 'promptLibrary', {
      configurable: true,
      value: {
        request: async (...args: Parameters<typeof request>) => ({
          ok: true,
          value: await request(...args),
        }),
      },
    });
    render(<Manager />);
    await screen.findByTestId('prompt-workbench-panel');
    expect(request).toHaveBeenCalledWith({ filter: {}, operation: 'list' });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('loads prompts and projects the active thread and enabled LLMs', async () => {
    render(<Manager />);

    expect(screen.getByText('Opening Prompt Workbench…')).toBeInTheDocument();
    expect(await screen.findByTestId('prompt-workbench-panel')).toBeInTheDocument();
    expect(screen.getByTestId('active-thread-id')).toHaveTextContent('thread-active');
    expect(JSON.parse(screen.getByTestId('model-options').textContent ?? 'null')).toEqual([
      { key: 'openai::gpt-5.4', label: 'OpenAI · GPT-5.4' },
      { key: 'google::gemini-3.1-pro-preview', label: 'Google · Gemini 3.1 Pro' },
    ]);
  });

  it('ignores obsolete legacy localStorage without surfacing compatibility UI', async () => {
    const malformedLegacyValue = '{"version":1,';
    localStorage.setItem('brainstrike-prompt-store', malformedLegacyValue);
    repository.list.mockResolvedValue([testItem]);

    render(<Manager />);

    expect(await screen.findByTestId('prompt-workbench-panel')).toBeInTheDocument();
    expect(screen.getByTestId('first-item-title')).toHaveTextContent('Evidence rule');
    expect(screen.getByTestId('system-error')).toBeEmptyDOMElement();
    expect(localStorage.getItem('brainstrike-prompt-store')).toBe(malformedLegacyValue);
  });

  it('surfaces an alert when the prompt library capability is missing', () => {
    Reflect.deleteProperty(window, 'promptLibrary');

    render(<Manager />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Prompt Workbench requires the prompt library capability.'
    );
  });

  it('keeps an initial database listing failure fatal', async () => {
    repository.list.mockRejectedValueOnce(new Error('Prompt database is unavailable.'));

    render(<Manager />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Prompt database is unavailable.');
    expect(screen.queryByTestId('prompt-workbench-panel')).not.toBeInTheDocument();
  });

  it('stages insertions into the active thread rather than the selected sidebar thread', async () => {
    const user = userEvent.setup();
    render(<Manager />);
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
    render(<Manager />);

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
    render(<Manager />);
    await user.click(await screen.findByRole('button', { name: 'New thread from test item' }));

    await waitFor(() =>
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'thread-new',
      })
    );
    expect(mocks.createThread).toHaveBeenCalledWith(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-new']).toMatchObject({
      model: 'gpt-5.4',
      provider: 'openai',
    });
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['thread-new']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
    expect(mocks.recordUsage).toHaveBeenCalledWith(testItem.id, 'new-thread');
  });

  it('creates the thread through the host and surfaces a title the host cannot store yet', async () => {
    const user = userEvent.setup();
    const hostCreate = vi.fn(async (resourceId: string) => ({
      createdAt: new Date('2026-10-08T00:00:00Z'),
      id: 'host-thread-new',
      resourceId,
      title: 'New Thread',
      updatedAt: new Date('2026-10-08T00:00:00Z'),
    }));
    const host: AssistantThreadHostCapability = {
      createThread: hostCreate,
      deleteThread: vi.fn(),
      listThreads: vi.fn(async () => []),
      ownsThread: vi.fn(),
      renameThread: vi.fn(),
      renderThread: vi.fn(),
      updateThreadBinding: vi.fn(),
      workspaceRepository: () => {
        throw new Error('Unexpected workspace snapshot access in this fixture');
      },
    };
    render(
      <AssistantThreadHostContext.Provider value={host}>
        <ConnectedPromptManager />
      </AssistantThreadHostContext.Provider>
    );
    await user.click(await screen.findByRole('button', { name: 'New thread from test item' }));

    await waitFor(() =>
      expect(useAssistantThreadStore.getState().activeThreadIdByResourceId).toMatchObject({
        [WORKSPACE_MEMORY_RESOURCE_ID]: 'host-thread-new',
      })
    );
    expect(hostCreate).toHaveBeenCalledExactlyOnceWith(WORKSPACE_MEMORY_RESOURCE_ID);
    expect(mocks.createThread).not.toHaveBeenCalled();
    // The requested title is never dropped silently.
    expect(screen.getByTestId('system-error')).toHaveTextContent(testItem.title);
    expect(
      useAssistantComposerCommandStore.getState().commandsByThreadId['host-thread-new']?.[0]
    ).toMatchObject({ mode: 'replace', text: testItem.content });
  });

  it('applies a runnable prompt model to the active thread before staging it', async () => {
    const user = userEvent.setup();
    render(<Manager />);
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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);

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
    render(<Manager />);
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
    render(<Manager />);
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
    mocks.getAvailableProviders.mockResolvedValue(['anthropic']);
    render(<Manager />);
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
});
