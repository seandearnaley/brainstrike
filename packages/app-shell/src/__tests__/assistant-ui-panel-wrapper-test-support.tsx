import {
  type LocalLlmBackendFactory,
  NATIVE_TOOL_DEFAULTS,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import type { LocalRuntimeModelCatalogState } from '@brainstrike/assistant-contract/local-runtime';
import { __resetAssistantPreferencesStoreForTests } from '@brainstrike/preferences';
import { __resetWorkspaceCollectionSyncStatusStoreForTests } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { __resetAssistantForegroundActivityForTests } from '../assistant-foreground-activity';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';

export const NATIVE_TOOL_COUNT = Object.keys(NATIVE_TOOL_DEFAULTS).length;

const { hasDesktopLlmHostMock } = vi.hoisted(() => ({
  hasDesktopLlmHostMock: vi.fn((): boolean => false),
}));

const { fileExplorerMocks, preparedRequestDataLog, testEnabledModels } = vi.hoisted(() => ({
  fileExplorerMocks: {
    addMultipleSelectedFiles: vi.fn<(folderId: string, paths: string[]) => void>(),
    clearSelectionRules: vi.fn<() => void>(),
    currentFolderId: 'test-folder' as string | null,
    effectiveSelection: new Set<string>(),
    includeProjectTree: false,
    removeMultipleSelectedFiles: vi.fn<(folderId: string, paths: string[]) => void>(),
    rootDirectoryHandle: {
      name: 'test-workspace',
      path: '/tmp/test-workspace',
    } as { path: string; name: string } | null,
    setIncludeProjectTree: vi.fn<(value: boolean) => void>(),
    setSelectedFiles: vi.fn<(files: ReadonlySet<string>) => void>(),
    setTokenBudget: vi.fn<(budget: number) => void>(),
    tokenBudget: 100_000,
    tokenCache: null as null | {
      cacheVersion: number;
      getTokenCount: (folderId: string, path: string) => number | undefined;
    },
    workspaceContextSnapshot: null as null | Record<string, unknown>,
    setTapestryRangesForKey: vi.fn<(key: string, ranges: unknown[]) => void>(),
    tapestryRangesByKey: {} as Record<string, unknown[]>,
  },
  // Track enabled models in a mutable Set for testing toggle functionality
  preparedRequestDataLog: [] as Array<Record<string, unknown> | undefined>,
  testEnabledModels: new Set<string>([
    // Mock catalog values, intentionally distinct from the real registry defaults
    // (openai gpt-5.4 / openrouter openai/gpt-5.4) so these tests don't churn when
    // defaults move; gpt-5.2 / openai/gpt-5.2 remain valid supported models.
    'gpt-5.2', // mock OpenAI selection
    'claude-sonnet-4-6', // Anthropic default
    'gemini-3.5-flash', // Google default
    'openai/gpt-5.2', // mock OpenRouter selection
  ]),
}));

// Mock preferences stores with lightweight Zustand stores to avoid loading the full package graph.
vi.mock('@brainstrike/preferences', async () => {
  const { create } = await import('zustand');

  const buildEnabledModelsByProvider = (): Record<string, string[]> => ({
    openai: testEnabledModels.has('gpt-5.2') ? ['gpt-5.2'] : [],
    anthropic: testEnabledModels.has('claude-sonnet-4-6') ? ['claude-sonnet-4-6'] : [],
    google: [
      testEnabledModels.has('gemini-3.5-flash') ? 'gemini-3.5-flash' : undefined,
      testEnabledModels.has('gemini-3.1-pro-preview') ? 'gemini-3.1-pro-preview' : undefined,
    ].filter((modelId): modelId is string => Boolean(modelId)),
    openrouter: [
      testEnabledModels.has('openai/gpt-5.2') ? 'openai/gpt-5.2' : undefined,
      testEnabledModels.has('anthropic/claude-sonnet-4.6')
        ? 'anthropic/claude-sonnet-4.6'
        : undefined,
      testEnabledModels.has('google/gemini-3.5-flash') ? 'google/gemini-3.5-flash' : undefined,
    ].filter((modelId): modelId is string => Boolean(modelId)),
  });

  const buildRegistryModels = () => [
    {
      id: 'gpt-5.2',
      providerId: 'openai',
      isEnabled: testEnabledModels.has('gpt-5.2'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      isEnabled: testEnabledModels.has('claude-sonnet-4-6'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'gemini-3.5-flash',
      providerId: 'google',
      isEnabled: testEnabledModels.has('gemini-3.5-flash'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'gemini-3.1-pro-preview',
      providerId: 'google',
      isEnabled: testEnabledModels.has('gemini-3.1-pro-preview'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'openai/gpt-5.2',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('openai/gpt-5.2'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'anthropic/claude-sonnet-4.6',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('anthropic/claude-sonnet-4.6'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'google/gemini-3.5-flash',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('google/gemini-3.5-flash'),
      capabilities: { type: 'llm' as const },
    },
  ];

  interface AssistantPreferencesState {
    clearModel: () => void;
    enabledModelsByProvider: Record<string, string[]>;
    getAvailableProviders: () => Promise<SupportedProvider[]>;
    getLocalRuntimeModels: () => Promise<{
      ollama: LocalRuntimeModelCatalogState;
      lmstudio: LocalRuntimeModelCatalogState;
    }>;
    getLocalRuntimeStatuses: () => Promise<{
      ollama: { state: 'unavailable'; checkedAt: number; message: string };
      lmstudio: { state: 'unavailable'; checkedAt: number; message: string };
    }>;
    getSelectedModel: () => string | null;
    getSelectedProvider: () => SupportedProvider | null;
    modelsByProvider: Record<string, string>;
    providerSettings: Record<string, Record<string, unknown>>;
    selectedModel: string | null;
    selectedProvider: SupportedProvider | null;
    setModel: (compositeKey: string) => void;
    setProviderSettings: (providerId: string, updates: Record<string, unknown>) => void;
  }

  interface AssistantMemoryPreferencesState {
    observationalMemory: {
      enabled: boolean;
      modelTarget: string;
      scope: 'thread' | 'resource';
      messageTokens: number;
      observationTokens: number;
      retrievalMode: 'off' | 'messages' | 'vector';
    };
    semanticRecall: {
      enabled: boolean;
      embeddingModelTarget: string | null;
      scope: 'thread' | 'resource';
      topK: number;
      messageRange: number;
    };
  }

  const useAssistantPreferencesStore = create<AssistantPreferencesState>((set, get) => ({
    selectedProvider: null,
    selectedModel: null,
    modelsByProvider: {},
    enabledModelsByProvider: buildEnabledModelsByProvider(),
    providerSettings: {},
    setModel: (compositeKey: string) => {
      const [provider, model] = compositeKey.split('::');
      if (!(provider && model)) {
        return;
      }
      set((state) => ({
        selectedProvider: provider as SupportedProvider,
        selectedModel: compositeKey,
        modelsByProvider: { ...state.modelsByProvider, [provider]: model },
      }));
    },
    clearModel: () => {
      set({
        selectedProvider: null,
        selectedModel: null,
      });
    },
    getAvailableProviders: async () => ['openai', 'anthropic', 'google', 'openrouter'],
    getLocalRuntimeStatuses: async () => ({
      ollama: {
        state: 'unavailable',
        checkedAt: 0,
        message: 'not detected',
      },
      lmstudio: {
        state: 'unavailable',
        checkedAt: 0,
        message: 'not detected',
      },
    }),
    getLocalRuntimeModels: async () => ({
      ollama: {
        state: 'loaded_empty',
        runtime: 'ollama',
        checkedAt: 0,
        availability: {
          state: 'available',
          checkedAt: 0,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 0,
        },
        endpoint: 'http://127.0.0.1:11434/v1/models',
        source: 'openai_v1_models',
        freshness: 'live',
        models: [],
      },
      lmstudio: {
        state: 'loaded_empty',
        runtime: 'lmstudio',
        checkedAt: 0,
        availability: {
          state: 'available',
          checkedAt: 0,
          endpoint: 'http://localhost:1234/v1/models',
          latencyMs: 0,
        },
        endpoint: 'http://localhost:1234/v1/models',
        source: 'openai_v1_models',
        freshness: 'live',
        models: [],
      },
    }),
    getSelectedProvider: () => get().selectedProvider,
    getSelectedModel: () => get().selectedModel,
    setProviderSettings: (providerId: string, updates: Record<string, unknown>) => {
      set((state) => ({
        providerSettings: {
          ...state.providerSettings,
          [providerId]: {
            ...(state.providerSettings[providerId] ?? {}),
            ...updates,
          },
        },
      }));
    },
  }));

  const defaultAssistantMemoryPreferences: AssistantMemoryPreferencesState = {
    observationalMemory: {
      enabled: true,
      modelTarget: 'openai/gpt-5.4-mini',
      scope: 'thread',
      messageTokens: 30_000,
      observationTokens: 40_000,
      retrievalMode: 'off',
    },
    semanticRecall: {
      enabled: false,
      embeddingModelTarget: 'openai/text-embedding-3-small',
      scope: 'resource',
      topK: 5,
      messageRange: 2,
    },
  };

  const useAssistantMemoryPreferencesStore = create<AssistantMemoryPreferencesState>(() => ({
    ...defaultAssistantMemoryPreferences,
  }));

  const useBackgroundIndexingPreferencesStore = create<{
    enabled: boolean;
    managedCollectionId: string | null;
    mode: 'root-folder-cache';
    paused: boolean;
  }>(() => ({
    enabled: true,
    managedCollectionId: 'managed-set-1',
    mode: 'root-folder-cache',
    paused: false,
  }));

  const useNativeToolPreferencesStore = create<{
    toolStates: Record<string, boolean>;
    setToolEnabled: (toolId: string, enabled: boolean) => void;
  }>((set) => ({
    toolStates: {},
    setToolEnabled: (toolId: string, enabled: boolean) => {
      set((state) => {
        const nextToolStates = { ...state.toolStates };
        if (enabled) {
          delete nextToolStates[toolId];
        } else {
          nextToolStates[toolId] = false;
        }
        return { toolStates: nextToolStates };
      });
    },
  }));

  const useSecretsStore = <T,>(selector: (state: { secretsVersion: number }) => T): T =>
    selector({ secretsVersion: 0 });

  const useVectorStatusUIStore = <T,>(
    selector: (state: { activeEmbeddingSetId: string | null }) => T
  ): T => selector({ activeEmbeddingSetId: null });

  const useModelRegistryStore = <T,>(
    selector: (state: {
      models: ReturnType<typeof buildRegistryModels>;
      hasLoaded: boolean;
      error: Error | null;
      toggleModel: (
        _db: unknown,
        modelId: string,
        enabled: boolean,
        _runtimeEngine: 'pglite' | 'turso'
      ) => void;
    }) => T
  ): T =>
    selector({
      models: buildRegistryModels(),
      hasLoaded: true,
      error: null,
      toggleModel: (
        _db: unknown,
        modelId: string,
        enabled: boolean,
        _runtimeEngine: 'pglite' | 'turso'
      ) => {
        if (enabled) {
          testEnabledModels.add(modelId);
        } else {
          testEnabledModels.delete(modelId);
        }
        useAssistantPreferencesStore.setState({
          enabledModelsByProvider: buildEnabledModelsByProvider(),
        });
      },
    });

  const __resetAssistantPreferencesStoreForTests = () => {
    useAssistantPreferencesStore.setState({
      selectedProvider: null,
      selectedModel: null,
      modelsByProvider: {},
      enabledModelsByProvider: buildEnabledModelsByProvider(),
      providerSettings: {},
    });
    useBackgroundIndexingPreferencesStore.setState({
      enabled: true,
      managedCollectionId: 'managed-set-1',
      mode: 'root-folder-cache',
      paused: false,
    });
    useAssistantMemoryPreferencesStore.setState({
      ...defaultAssistantMemoryPreferences,
    });
    useNativeToolPreferencesStore.setState({ toolStates: {} });
  };

  const usePanelLayoutStore = create<{
    activeTab: string;
    setActiveTab: (tab: string) => void;
  }>((set) => ({
    activeTab: 'explorer',
    setActiveTab: (tab: string) => set({ activeTab: tab }),
  }));

  return {
    __resetAssistantPreferencesStoreForTests,
    useAssistantMemoryPreferencesStore,
    useAssistantPreferencesStore,
    useBackgroundIndexingPreferencesStore,
    useEnsureModelRegistry: vi.fn(),
    useModelRegistryStore,
    useNativeToolPreferencesStore,
    usePanelLayoutStore,
    useSecretsStore,
    useVectorStatusUIStore,
  };
});

vi.mock('@brainstrike/preferences/hooks/use-model-registry', async () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/preferences/stores/assistant-preferences-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useAssistantPreferencesStore: preferences.useAssistantPreferencesStore,
  };
});

vi.mock('@brainstrike/preferences/stores/assistant-memory-preferences-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useAssistantMemoryPreferencesStore: preferences.useAssistantMemoryPreferencesStore,
  };
});

vi.mock('@brainstrike/preferences/stores/background-indexing-preferences-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useBackgroundIndexingPreferencesStore: preferences.useBackgroundIndexingPreferencesStore,
  };
});

vi.mock('@brainstrike/preferences/stores/model-registry-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useModelRegistryStore: preferences.useModelRegistryStore,
  };
});

vi.mock('@brainstrike/preferences/stores/native-tool-preferences-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useNativeToolPreferencesStore: preferences.useNativeToolPreferencesStore,
  };
});

vi.mock('@brainstrike/preferences/stores/panel-layout-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    usePanelLayoutStore: preferences.usePanelLayoutStore,
  };
});

vi.mock('@brainstrike/preferences/stores/secrets-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useSecretsStore: preferences.useSecretsStore,
  };
});

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', async () => {
  const preferences = await import('@brainstrike/preferences');
  return {
    useVectorStatusUIStore: preferences.useVectorStatusUIStore,
  };
});

const { dbClientState, mockDb } = vi.hoisted(() => ({
  dbClientState: {
    assistantMemoryDb: undefined as unknown,
    brainstrikeDb: undefined as unknown,
    modelRegistryDb: undefined as unknown,
  },
  mockDb: {
    exec: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// Mock the DB hook
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useDbInitializing: vi.fn(() => false),
  useDbProviderError: vi.fn(() => null),
  useBrainstrikeDbClient: vi.fn(() =>
    dbClientState.brainstrikeDb === undefined ? mockDb : dbClientState.brainstrikeDb
  ),
  useOptionalPGliteDatabase: vi.fn(() =>
    dbClientState.brainstrikeDb === undefined ? mockDb : dbClientState.brainstrikeDb
  ),
  useBrainstrikeLiveQueryCapability: vi.fn(() => false),
  useFileRecordRepository: vi.fn(() => null),
  useModelRegistryDbClient: vi.fn(() =>
    dbClientState.modelRegistryDb === undefined ? mockDb : dbClientState.modelRegistryDb
  ),
  useAssistantMemoryDbClient: vi.fn(() =>
    dbClientState.assistantMemoryDb === undefined
      ? { db: mockDb, runtimeEngine: 'pglite' }
      : dbClientState.assistantMemoryDb
  ),
  useOptionalProfileBootstrapReport: vi.fn(() => ({
    runtime: { engine: 'pglite' },
  })),
  // The OM segment live query (useObservationalMemoryRow) and the "@" file
  // mention query (useFileMentions) — inert in these tests (no rows, not
  // loading) so neither runs a real subscription.
  useBrainstrikeLiveQuery: vi.fn(() => ({
    rows: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
  // Quick-open / file-mention shared query constants (useFileMentions).
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => {
  // Stable references for the "@" file-mention selectors (useFileMentions reads
  // these via useFileExplorerStoreSelector). A fresh `[]`/`{}` per getState()
  // call would make the selector return a new value every render → re-render
  // churn that re-runs subscription effects (broke the root-tree
  // unsubscribe-once assertion).
  const stableActiveRootIds: string[] = [];
  const stableRootDescriptors: Record<string, unknown> = {};
  const getState = () => ({
    tokenBudget: fileExplorerMocks.tokenBudget,
    currentFolderId: fileExplorerMocks.currentFolderId,
    rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle,
    includeProjectTree: fileExplorerMocks.includeProjectTree,
    // "@" file-mention gating (useFileMentions) reads these; empty in these
    // tests so the mention query yields no candidates.
    activeRootIds: stableActiveRootIds,
    rootDescriptors: stableRootDescriptors,
    setTokenBudget: fileExplorerMocks.setTokenBudget,
    setIncludeProjectTree: fileExplorerMocks.setIncludeProjectTree,
    setSelectedFiles: fileExplorerMocks.setSelectedFiles,
    addMultipleSelectedFiles: fileExplorerMocks.addMultipleSelectedFiles,
    removeMultipleSelectedFiles: fileExplorerMocks.removeMultipleSelectedFiles,
    clearSelectionRules: fileExplorerMocks.clearSelectionRules,
  });

  const store = (selector?: (state: ReturnType<typeof getState>) => unknown) => {
    const state = getState();
    return selector ? selector(state) : state;
  };

  return {
    useSelectionManager: () => ({ effectiveSelection: fileExplorerMocks.effectiveSelection }),
    useFileSystem: () => ({ rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle }),
    useFileExplorerStoreContext: () => store,
    useFileExplorerStoreSelector: (selector: (state: ReturnType<typeof getState>) => unknown) =>
      selector(getState()),
  };
});

vi.mock('@brainstrike/file-explorer-ui/preview', () => {
  const getWorkspaceContextCurationState = () => ({
    contextSnapshot: fileExplorerMocks.workspaceContextSnapshot,
    setTapestryRangesForKey: fileExplorerMocks.setTapestryRangesForKey,
    tapestryRangesByKey: fileExplorerMocks.tapestryRangesByKey,
  });
  const useWorkspaceContextCurationStore = Object.assign(
    (selector: (state: ReturnType<typeof getWorkspaceContextCurationState>) => unknown): unknown =>
      selector(getWorkspaceContextCurationState()),
    {
      getState: getWorkspaceContextCurationState,
    }
  );

  return {
    toolLineRangeToTapestryRange: (range: { endLine: number; startLine: number }) => ({
      startLine: range.startLine - 1,
      endLine: range.endLine,
    }),
    useWorkspaceContextCurationStore,
  };
});

// Mock the assistant local-runtime contract exports used by the wrapper.
vi.mock('@brainstrike/assistant-contract/local-runtime', () => {
  const PROVIDER_DEFINITIONS = {
    openai: {
      id: 'openai',
      displayName: 'OpenAI',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [{ id: 'gpt-5.2', type: 'llm', default: true, supportsStreaming: true }],
    },
    anthropic: {
      id: 'anthropic',
      displayName: 'Anthropic',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [{ id: 'claude-sonnet-4-6', type: 'llm', default: true, supportsStreaming: true }],
    },
    google: {
      id: 'google',
      displayName: 'Google AI Studio',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        { id: 'gemini-3.5-flash', type: 'llm', default: true, supportsStreaming: true },
        { id: 'gemini-3.1-pro-preview', type: 'llm', supportsStreaming: true },
      ],
    },
    openrouter: {
      id: 'openrouter',
      displayName: 'OpenRouter',
      runtime: 'gateway',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [
        { id: 'openai/gpt-5.2', type: 'llm', default: true, supportsStreaming: true },
        { id: 'anthropic/claude-sonnet-4.6', type: 'llm', supportsStreaming: true },
        { id: 'google/gemini-3.5-flash', type: 'llm', supportsStreaming: true },
      ],
    },
    ollama: {
      id: 'ollama',
      displayName: 'Ollama',
      runtime: 'local',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [{ id: 'nomic-embed-text', type: 'llm', default: true, supportsStreaming: true }],
    },
    lmstudio: {
      id: 'lmstudio',
      displayName: 'LM Studio',
      runtime: 'local',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        {
          id: 'text-embedding-nomic-embed-text-v1.5',
          type: 'llm',
          default: true,
          supportsStreaming: true,
        },
      ],
    },
  } as const;

  const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as Array<
    keyof typeof PROVIDER_DEFINITIONS
  >;

  const PROVIDER_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      acc[provider] = PROVIDER_DEFINITIONS[provider].models.map((model) => model.id);
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string[]>
  );

  const PROVIDER_DEFAULT_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      const models = PROVIDER_DEFINITIONS[provider].models;
      const defaultModel = models.find((model) => 'default' in model && model.default) ?? models[0];
      acc[provider] = defaultModel.id;
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string>
  );

  // Models that are enabled by default (only those with default: true)
  const PROVIDER_DEFAULT_ENABLED_MODELS = SUPPORTED_PROVIDERS.reduce(
    (acc, provider) => {
      const models = PROVIDER_DEFINITIONS[provider].models;
      const defaultModels = models
        .filter((model) => 'default' in model && model.default)
        .map((model) => model.id);
      acc[provider] = defaultModels;
      return acc;
    },
    {} as Record<keyof typeof PROVIDER_DEFINITIONS, string[]>
  );

  return {
    getProviderDefaultModel: (provider: string) =>
      PROVIDER_DEFAULT_MODELS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderDisplayName: (provider: string) => {
      const definition = PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS];
      return definition?.displayName ?? provider;
    },
    getProviderModels: (provider: string) =>
      PROVIDER_MODELS[provider as keyof typeof PROVIDER_MODELS] ?? [],
    getProviderDefinition: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderModelDefinitions: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS]?.models ?? [],
    isLoadedRuntimeModelCatalogState: (
      state: LocalRuntimeModelCatalogState | null | undefined
    ): state is Extract<
      LocalRuntimeModelCatalogState,
      { state: 'loaded_non_empty' | 'stale_cached' }
    > => Boolean(state && (state.state === 'loaded_non_empty' || state.state === 'stale_cached')),
    isSupportedProvider: (provider: string) =>
      SUPPORTED_PROVIDERS.includes(provider as keyof typeof PROVIDER_DEFINITIONS),
    supportsStandardEmbeddingDimension: (provider: string) => provider !== 'openrouter',
    listProviders: () => SUPPORTED_PROVIDERS.map((provider) => PROVIDER_DEFINITIONS[provider]),
    PROVIDER_DEFAULT_ENABLED_MODELS,
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
  };
});

// The "/" slash-command projection depends on the theme/toast/command-registry
// seam (covered by its own unit tests). The wrapper suite focuses on
// provider/model/transport logic, so stub the hook to an empty list — it needs
// no ThemeProvider/ToastProvider here.
vi.mock('../use-assistant-slash-commands', () => ({
  useAssistantSlashCommands: () => [],
}));

// Mock the AssistantUiPanel component
vi.mock('@brainstrike/ui/assistant-ui-panel', () => ({
  // Defaults to no desktop llm-host bridge, so local chat resolves to the
  // in-renderer transport; tests flip the mock to cover the data-stream route.
  hasDesktopLlmHost: hasDesktopLlmHostMock,
  AssistantUiPanel: ({
    providerGroups = [],
    selectedProvider,
    selectedModel,
    onModelChange,
    onModelToggle,
    onProviderSettingsChange,
    onRunEvent,
    onThreadRunStart,
    completePreparedRequest,
    prepareRequestData,
    contextMenu,
    localChatTransport,
    requestData,
    disabled,
    disabledReason,
    toolMenu,
  }: {
    providerGroups?: Array<{
      runtime: string;
      label: string;
      providers: Array<{
        id: string;
        name: string;
        models: Array<{ id: string; enabled: boolean }>;
      }>;
    }>;
    selectedProvider?: string;
    selectedModel?: string;
    onModelChange?: (compositeKey: string) => void;
    onModelToggle?: (provider: string, model: string, enabled: boolean) => void;
    onProviderSettingsChange?: (providerId: string, updates: Record<string, unknown>) => void;
    onRunEvent?: (event: {
      id: string;
      kind: 'memory.observation.completed';
      label: string;
      status: 'completed';
      timestamp: string;
    }) => void;
    onThreadRunStart?: () => void;
    completePreparedRequest?: (
      requestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ) => Promise<void> | void;
    prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
    contextMenu?: Record<string, unknown>;
    localChatTransport?: string;
    requestData?: Record<string, unknown>;
    disabled?: boolean;
    disabledReason?: string;
    toolMenu?: {
      items: Array<{ id: string; enabled: boolean }>;
      isLoading?: boolean;
      onToggleTool?: (toolId: string, enabled: boolean) => void;
      onRefresh?: () => void;
      onOpenSettings?: () => void;
    };
  }) => {
    const providers = providerGroups?.flatMap((group) => group.providers) ?? [];
    const currentProvider = providers.find((p) => p.id === selectedProvider);
    const enabledModels = currentProvider?.models.filter((m) => m.enabled) ?? [];
    const allModels = currentProvider?.models ?? [];

    // Extract model name from composite key (format: "provider::model")
    const extractModelName = (compositeKey: string | undefined) => {
      if (!compositeKey) {
        return '';
      }
      const parts = compositeKey.split('::');
      return parts.length === 2 ? parts[1] : compositeKey;
    };

    const modelName = extractModelName(selectedModel);

    return (
      <div data-testid="assistant-ui-panel">
        <div data-testid="panel-disabled">{String(disabled)}</div>
        <div data-testid="local-chat-transport">{localChatTransport ?? ''}</div>
        <div data-testid="request-data">{JSON.stringify(requestData ?? {})}</div>
        <div data-testid="context-menu">{JSON.stringify(contextMenu ?? {})}</div>
        {disabledReason && <div data-testid="disabled-reason">{disabledReason}</div>}
        <div data-testid="tool-menu-count">{toolMenu?.items.length ?? 0}</div>
        <div data-testid="tool-menu-loading">{String(toolMenu?.isLoading ?? false)}</div>
        <button
          data-testid="tool-menu-refresh"
          onClick={() => toolMenu?.onRefresh?.()}
          type="button"
        >
          Refresh tools
        </button>
        <button
          data-testid="tool-menu-open-settings"
          onClick={() => toolMenu?.onOpenSettings?.()}
          type="button"
        >
          Open settings
        </button>
        {toolMenu?.items.map((item) => (
          <div data-testid={`tool-menu-item-${item.id}`} key={item.id}>
            <span>{item.id}</span>
            <button
              data-testid={`tool-toggle-${item.id}`}
              onClick={() => toolMenu?.onToggleTool?.(item.id, !item.enabled)}
              type="button"
            >
              Toggle
            </button>
          </div>
        ))}

        <select
          data-testid="provider-select"
          disabled={providers.length === 0}
          onChange={(e) => {
            // When provider changes, construct composite key with default model if enabled, otherwise first enabled model
            const newProvider = e.target.value;
            const provider = providers.find((p) => p.id === newProvider);
            if (provider) {
              const enabledModels = provider.models.filter((m) => m.enabled);
              const defaultModel = enabledModels.find((m) => 'default' in m && m.default);
              const modelToSelect = defaultModel ?? enabledModels[0];
              if (modelToSelect) {
                onModelChange?.(`${newProvider}::${modelToSelect.id}`);
              }
            }
          }}
          value={selectedProvider ?? ''}
        >
          <option value="">Select provider</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>

        <select
          data-testid="model-select"
          disabled={!selectedProvider || enabledModels.length === 0}
          onChange={(e) => {
            // Construct composite key when model changes
            if (selectedProvider) {
              onModelChange?.(`${selectedProvider}::${e.target.value}`);
            }
          }}
          value={modelName}
        >
          <option value="">Select model</option>
          {enabledModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.id}
            </option>
          ))}
        </select>

        <div data-testid="model-toggles">
          {allModels.map((model) => (
            <label htmlFor={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`} key={model.id}>
              <input
                checked={model.enabled}
                data-testid={`model-toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
                id={`toggle-${currentProvider?.id ?? 'none'}-${model.id}`}
                onChange={(event) =>
                  onModelToggle?.(currentProvider?.id ?? '', model.id, event.target.checked)
                }
                type="checkbox"
              />
              {model.id}
            </label>
          ))}
        </div>
        <button data-testid="submit-thread-run" onClick={onThreadRunStart} type="button">
          Submit
        </button>
        <button
          data-testid="emit-observational-memory-updated"
          onClick={() =>
            onRunEvent?.({
              id: 'event-observations-updated',
              kind: 'memory.observation.completed',
              label: 'Observations updated',
              status: 'completed',
              timestamp: '2026-07-03T01:00:00.000Z',
            })
          }
          type="button"
        >
          Emit OM update
        </button>
        <button
          data-testid="provider-settings-change-openai"
          onClick={() =>
            onProviderSettingsChange?.('openai', {
              maxOutputTokens: 2048,
              reasoningEffort: 'low',
            })
          }
          type="button"
        >
          Change OpenAI settings
        </button>
        <button
          data-testid="provider-settings-clear-openai"
          onClick={() =>
            onProviderSettingsChange?.('openai', {
              agentMaxSteps: undefined,
              maxOutputTokens: undefined,
              reasoningEffort: undefined,
            })
          }
          type="button"
        >
          Clear OpenAI settings
        </button>
        <button
          data-testid="prepare-thread-request"
          onClick={async () => {
            try {
              preparedRequestDataLog.push(await prepareRequestData?.());
            } catch (error) {
              preparedRequestDataLog.push({
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }}
          type="button"
        >
          Prepare request
        </button>
        <button
          data-testid="complete-prepared-request-success"
          onClick={async () => {
            await completePreparedRequest?.(preparedRequestDataLog.at(-1), 'completed');
          }}
          type="button"
        >
          Complete prepared request
        </button>
        <button
          data-testid="complete-prepared-request-failure"
          onClick={async () => {
            await completePreparedRequest?.(
              preparedRequestDataLog.at(-1),
              'failed',
              'model failed'
            );
          }}
          type="button"
        >
          Fail prepared request
        </button>
        <button
          data-testid="complete-prepared-request-without-run"
          onClick={async () => {
            await completePreparedRequest?.(
              { memory: { threadId: 'thread-existing' } },
              'completed'
            );
          }}
          type="button"
        >
          Complete request without run
        </button>
      </div>
    );
  },
  // The wrapper reads the usage store both as a hook (selector at render time)
  // and via getState() inside the usage callback. The mock supports both: the
  // selector receives an empty usage map and getState exposes recordUsage.
  useContextUsageStore: Object.assign(
    (selector: (state: { usageByThread: Record<string, unknown> }) => unknown) =>
      selector({ usageByThread: {} }),
    {
      getState: () => ({ recordUsage: () => {} }),
    }
  ),
}));

// Reset enabled models to defaults before each test
function resetTestEnabledModels() {
  testEnabledModels.clear();
  // Default enabled models (those with default: true in the mock)
  testEnabledModels.add('gpt-5.2'); // OpenAI default
  testEnabledModels.add('openai/gpt-5.2'); // OpenRouter default
  testEnabledModels.add('claude-sonnet-4-6'); // Anthropic default
  testEnabledModels.add('gemini-3.5-flash'); // Google default
}

beforeEach(() => {
  resetTestEnabledModels();
  __resetAssistantPreferencesStoreForTests();
  __resetAssistantForegroundActivityForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
  useAssistantThreadStore.setState({
    activeThreadIdByResourceId: {},
    draftRuntimeByThreadId: {},
    loadStateByResourceId: {},
    openThreadIdsByResourceId: {},
    selectedThreadByResourceId: {},
    threadIdsByResourceId: {},
    threadsByResourceId: {},
  });
  preparedRequestDataLog.splice(0, preparedRequestDataLog.length);
  fileExplorerMocks.effectiveSelection = new Set<string>();
  fileExplorerMocks.tokenCache = null;
  fileExplorerMocks.currentFolderId = 'test-folder';
  fileExplorerMocks.includeProjectTree = false;
  fileExplorerMocks.rootDirectoryHandle = {
    path: '/tmp/test-workspace',
    name: 'test-workspace',
  };
  fileExplorerMocks.tokenBudget = 100_000;
  fileExplorerMocks.workspaceContextSnapshot = null;
  fileExplorerMocks.tapestryRangesByKey = {};
  fileExplorerMocks.addMultipleSelectedFiles.mockReset();
  fileExplorerMocks.clearSelectionRules.mockReset();
  fileExplorerMocks.removeMultipleSelectedFiles.mockReset();
  fileExplorerMocks.setTapestryRangesForKey.mockReset();
  fileExplorerMocks.setIncludeProjectTree.mockReset();
  fileExplorerMocks.setSelectedFiles.mockReset();
  fileExplorerMocks.setTokenBudget.mockReset();
  mockDb.query.mockReset();
  mockDb.exec.mockReset();
  mockDb.exec.mockResolvedValue(undefined);
  dbClientState.brainstrikeDb = undefined;
  dbClientState.modelRegistryDb = undefined;
  dbClientState.assistantMemoryDb = undefined;
  mockDb.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM mastra_threads')) {
      return {
        rows: [
          {
            id: 'thread-existing',
            resourceId: '/tmp/test-workspace',
            title: 'Existing thread',
            createdAt: new Date('2026-04-22T10:00:00Z'),
            updatedAt: new Date('2026-04-22T10:00:00Z'),
          },
        ],
      };
    }
    return { rows: [] };
  });
  Object.defineProperty(window, 'assistant', {
    configurable: true,
    value: { url: 'http://127.0.0.1:9876' },
  });
  window.localStorage.removeItem('brainstrike.assistant.include-file-report.v1');
  window.localStorage.removeItem('brainstrike-assistant-threads-v1');
});

afterEach(() => {
  __resetAssistantPreferencesStoreForTests();
  __resetAssistantForegroundActivityForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
  Reflect.deleteProperty(window, 'tools');
  Reflect.deleteProperty(window, 'mcp');
  Reflect.deleteProperty(window, 'assistant');
  Reflect.deleteProperty(window, 'desktopLifecycle');
  Reflect.deleteProperty(window, '__brainstrikeAssistantRuntimeTestHooks__');
});

export const loadTestLocalLlmBackend: LocalLlmBackendFactory = async () => ({
  dispose: async () => undefined,
  generate: async () => ({
    finishReason: 'stop',
    text: '',
    usage: {
      completionTokens: 0,
      promptTokens: 0,
      totalTokens: 0,
    },
  }),
  initialize: async () => undefined,
  isReady: () => true,
});

export const renderAssistantPanel = async (
  providers: string[],
  afterRender?: () => Promise<void>
) => {
  const renderResult = render(
    <AssistantUiPanelWrapper
      initialProviders={providers as SupportedProvider[]}
      loadLocalLlmBackend={loadTestLocalLlmBackend}
    />
  );

  if (afterRender) {
    await afterRender();
  }

  return renderResult;
};

export const renderAssistantThreadPanel = async (
  providers: string[],
  threadId: string,
  afterRender?: () => Promise<void>
) => {
  const renderResult = render(
    <AssistantUiPanelWrapper
      initialProviders={providers as SupportedProvider[]}
      loadLocalLlmBackend={loadTestLocalLlmBackend}
      memoryResourceId="/tmp/test-workspace"
      memoryThreadId={threadId}
    />
  );

  if (afterRender) {
    await afterRender();
  }

  return renderResult;
};

export interface McpToolDescriptor {
  description?: string;
  enabled: boolean;
  id: string;
}

interface McpApi {
  disableTools?: (toolIds: string[]) => Promise<void>;
  enableTools?: (toolIds: string[]) => Promise<void>;
  listTools: () => Promise<Record<string, McpToolDescriptor[]>>;
  onToolsUpdated?: (callback: (tools: Record<string, McpToolDescriptor[]>) => void) => () => void;
}

export const setMcpApi = (overrides: Partial<McpApi> = {}) => {
  const api: McpApi = {
    listTools: vi.fn().mockResolvedValue({}),
    enableTools: vi.fn().mockResolvedValue(undefined),
    disableTools: vi.fn().mockResolvedValue(undefined),
    onToolsUpdated: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  (window as typeof window & { mcp?: McpApi }).mcp = api;
  return api;
};

export const readPanelRequestData = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('request-data').textContent ?? '{}') as Record<string, unknown>;

export const readPanelContextMenu = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('context-menu').textContent ?? '{}') as Record<string, unknown>;

export type SelectionUpdateHandler = (
  payload: Omit<AssistantSelectionUpdatePayload, 'mode'> & {
    mode?: AssistantSelectionUpdatePayload['mode'];
  }
) => void;

export function setMockDbClientsForAssistantPanel(options: {
  readonly assistantMemoryDb?: unknown;
  readonly brainstrikeDb?: unknown;
  readonly modelRegistryDb?: unknown;
}) {
  dbClientState.assistantMemoryDb = options.assistantMemoryDb;
  dbClientState.brainstrikeDb = options.brainstrikeDb;
  dbClientState.modelRegistryDb = options.modelRegistryDb;
}

export {
  fileExplorerMocks,
  hasDesktopLlmHostMock,
  mockDb,
  preparedRequestDataLog,
  testEnabledModels,
};
