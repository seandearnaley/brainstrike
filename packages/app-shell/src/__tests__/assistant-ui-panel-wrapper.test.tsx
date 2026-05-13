import type { LocalRuntimeModelCatalogState, SupportedProvider } from '@brainstrike/agent/client';
import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/agent/tool-metadata';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantMemoryPreferencesStore,
  useAssistantPreferencesStore,
  usePanelLayoutStore,
} from '@brainstrike/preferences';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useAssistantThreadStore } from '../assistant-thread-store';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';

const NATIVE_TOOL_COUNT = Object.keys(NATIVE_TOOL_DEFAULTS).length;

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
  },
  // Track enabled models in a mutable Set for testing toggle functionality
  preparedRequestDataLog: [] as Array<Record<string, unknown> | undefined>,
  testEnabledModels: new Set<string>([
    'gpt-5.2', // OpenAI default
    'claude-sonnet-4-5', // Anthropic default
    'gemini-3-flash-preview', // Google default
    'openai/gpt-5.2', // OpenRouter default
  ]),
}));

// Mock preferences stores with lightweight Zustand stores to avoid loading the full package graph.
vi.mock('@brainstrike/preferences', async () => {
  const { create } = await import('zustand');

  const buildEnabledModelsByProvider = (): Record<string, string[]> => ({
    openai: testEnabledModels.has('gpt-5.2') ? ['gpt-5.2'] : [],
    anthropic: testEnabledModels.has('claude-sonnet-4-5') ? ['claude-sonnet-4-5'] : [],
    google: [
      testEnabledModels.has('gemini-3-flash-preview') ? 'gemini-3-flash-preview' : undefined,
      testEnabledModels.has('gemini-3-pro-preview') ? 'gemini-3-pro-preview' : undefined,
    ].filter((modelId): modelId is string => Boolean(modelId)),
    openrouter: [
      testEnabledModels.has('openai/gpt-5.2') ? 'openai/gpt-5.2' : undefined,
      testEnabledModels.has('anthropic/claude-sonnet-4.5')
        ? 'anthropic/claude-sonnet-4.5'
        : undefined,
      testEnabledModels.has('google/gemini-3-flash-preview')
        ? 'google/gemini-3-flash-preview'
        : undefined,
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
      id: 'claude-sonnet-4-5',
      providerId: 'anthropic',
      isEnabled: testEnabledModels.has('claude-sonnet-4-5'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'gemini-3-flash-preview',
      providerId: 'google',
      isEnabled: testEnabledModels.has('gemini-3-flash-preview'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'gemini-3-pro-preview',
      providerId: 'google',
      isEnabled: testEnabledModels.has('gemini-3-pro-preview'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'openai/gpt-5.2',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('openai/gpt-5.2'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'anthropic/claude-sonnet-4.5',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('anthropic/claude-sonnet-4.5'),
      capabilities: { type: 'llm' as const },
    },
    {
      id: 'google/gemini-3-flash-preview',
      providerId: 'openrouter',
      isEnabled: testEnabledModels.has('google/gemini-3-flash-preview'),
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
      modelTarget: 'openai/gpt-5.2-chat-latest',
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

  const nativeToolPreferencesState: {
    toolStates: Record<string, boolean>;
    setToolEnabled: (toolId: string, enabled: boolean) => void;
  } = {
    toolStates: {},
    setToolEnabled: (toolId: string, enabled: boolean) => {
      nativeToolPreferencesState.toolStates = {
        ...nativeToolPreferencesState.toolStates,
        [toolId]: enabled,
      };
    },
  };

  const useNativeToolPreferencesStore = <T,>(
    selector: (state: typeof nativeToolPreferencesState) => T
  ): T => selector(nativeToolPreferencesState);

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
      toggleModel: (_db: unknown, modelId: string, enabled: boolean) => void;
    }) => T
  ): T =>
    selector({
      models: buildRegistryModels(),
      hasLoaded: true,
      error: null,
      toggleModel: (_db: unknown, modelId: string, enabled: boolean) => {
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
    nativeToolPreferencesState.toolStates = {};
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

const { mockDb } = vi.hoisted(() => ({
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
  usePGliteDatabase: vi.fn(() => mockDb),
}));

vi.mock('@brainstrike/file-explorer-ui', () => {
  const getState = () => ({
    tokenBudget: fileExplorerMocks.tokenBudget,
    currentFolderId: fileExplorerMocks.currentFolderId,
    rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle,
    includeProjectTree: fileExplorerMocks.includeProjectTree,
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
    useFileExplorerStoreContext: () => store,
    useFileExplorerStoreSelector: (selector: (state: ReturnType<typeof getState>) => unknown) =>
      selector(getState()),
    useOptionalTokenCacheContext: () => fileExplorerMocks.tokenCache,
  };
});

// Mock the agent/client exports
vi.mock('@brainstrike/agent/client', () => {
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
      models: [{ id: 'claude-sonnet-4-5', type: 'llm', default: true, supportsStreaming: true }],
    },
    google: {
      id: 'google',
      displayName: 'Google AI Studio',
      runtime: 'hosted',
      capabilities: { llm: true, embeddings: true, streaming: true },
      models: [
        { id: 'gemini-3-flash-preview', type: 'llm', default: true, supportsStreaming: true },
        { id: 'gemini-3-pro-preview', type: 'llm', supportsStreaming: true },
      ],
    },
    openrouter: {
      id: 'openrouter',
      displayName: 'OpenRouter',
      runtime: 'gateway',
      capabilities: { llm: true, embeddings: false, streaming: true },
      models: [
        { id: 'openai/gpt-5.2', type: 'llm', default: true, supportsStreaming: true },
        { id: 'anthropic/claude-sonnet-4.5', type: 'llm', supportsStreaming: true },
        { id: 'google/gemini-3-flash-preview', type: 'llm', supportsStreaming: true },
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

  const NATIVE_TOOL_DEFAULTS = {};

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
    NATIVE_TOOL_DEFAULTS,
  };
});

vi.mock('@brainstrike/agent/local-llm', () => ({
  LocalLlmBackend: {
    getBestDevice: vi.fn(() => 'webgpu'),
  },
}));

// Mock the AssistantUiPanel component
vi.mock('@brainstrike/ui/assistant-ui-panel', () => ({
  AssistantUiPanel: ({
    providerGroups = [],
    selectedProvider,
    selectedModel,
    onModelChange,
    onModelToggle,
    onProviderSettingsChange,
    onThreadRunStart,
    completePreparedRequest,
    prepareRequestData,
    contextMenu,
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
    onThreadRunStart?: () => void;
    completePreparedRequest?: (
      requestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ) => Promise<void> | void;
    prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
    contextMenu?: Record<string, unknown>;
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
}));

// Reset enabled models to defaults before each test
function resetTestEnabledModels() {
  testEnabledModels.clear();
  // Default enabled models (those with default: true in the mock)
  testEnabledModels.add('gpt-5.2'); // OpenAI default
  testEnabledModels.add('openai/gpt-5.2'); // OpenRouter default
  testEnabledModels.add('claude-sonnet-4-5'); // Anthropic default
  testEnabledModels.add('gemini-3-flash-preview'); // Google default
}

beforeEach(() => {
  resetTestEnabledModels();
  __resetAssistantPreferencesStoreForTests();
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
  fileExplorerMocks.addMultipleSelectedFiles.mockReset();
  fileExplorerMocks.clearSelectionRules.mockReset();
  fileExplorerMocks.removeMultipleSelectedFiles.mockReset();
  fileExplorerMocks.setIncludeProjectTree.mockReset();
  fileExplorerMocks.setSelectedFiles.mockReset();
  fileExplorerMocks.setTokenBudget.mockReset();
  mockDb.query.mockReset();
  mockDb.exec.mockReset();
  mockDb.exec.mockResolvedValue(undefined);
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
  Reflect.deleteProperty(window, 'tools');
  Reflect.deleteProperty(window, 'mcp');
  Reflect.deleteProperty(window, 'assistant');
  Reflect.deleteProperty(window, 'desktopLifecycle');
  Reflect.deleteProperty(window, '__brainstrikeAssistantRuntimeTestHooks__');
});

const renderAssistantPanel = async (providers: string[], afterRender?: () => Promise<void>) => {
  const renderResult = render(
    <AssistantUiPanelWrapper initialProviders={providers as SupportedProvider[]} />
  );

  if (afterRender) {
    await afterRender();
  }

  return renderResult;
};

const renderAssistantThreadPanel = async (
  providers: string[],
  threadId: string,
  afterRender?: () => Promise<void>
) => {
  const renderResult = render(
    <AssistantUiPanelWrapper
      initialProviders={providers as SupportedProvider[]}
      memoryResourceId="/tmp/test-workspace"
      memoryThreadId={threadId}
    />
  );

  if (afterRender) {
    await afterRender();
  }

  return renderResult;
};

interface McpToolDescriptor {
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

const setMcpApi = (overrides: Partial<McpApi> = {}) => {
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

const readPanelRequestData = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('request-data').textContent ?? '{}') as Record<string, unknown>;

const readPanelContextMenu = (): Record<string, unknown> =>
  JSON.parse(screen.getByTestId('context-menu').textContent ?? '{}') as Record<string, unknown>;

type SelectionUpdateHandler = (
  payload: Omit<AssistantSelectionUpdatePayload, 'mode'> & {
    mode?: AssistantSelectionUpdatePayload['mode'];
  }
) => void;

describe('AssistantUiPanelWrapper', () => {
  test('auto-selects first provider and default model when none selected', async () => {
    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

          expect(providerSelect.value).toBe('openai');
          expect(modelSelect.value).toBe('gpt-5.2');
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows disabled reason when no providers available', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.'
          );
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows local runtime unavailable message when a local provider is selected but not configured', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      selectedProvider: 'ollama',
      selectedModel: 'ollama::nomic-embed-text',
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'nomic-embed-text',
      },
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'The selected local runtime is currently unavailable.'
          );
          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        },
        { timeout: 3000 }
      )
    );
  });

  test('reselects a valid local runtime model when the previously selected local model is unavailable', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      selectedProvider: 'ollama',
      selectedModel: 'ollama::retired-model',
      modelsByProvider: {
        ...state.modelsByProvider,
        ollama: 'retired-model',
      },
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'available',
          checkedAt: 10,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 5,
        },
        lmstudio: {
          state: 'unavailable',
          checkedAt: 10,
          message: 'not detected',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'loaded_non_empty',
          runtime: 'ollama',
          checkedAt: 10,
          availability: {
            state: 'available',
            checkedAt: 10,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 5,
          },
          endpoint: 'http://127.0.0.1:11434/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: true, embeddings: 'supported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'known', values: [768], verifiedAt: 10, endpoint: '' },
            },
          ],
        },
        lmstudio: {
          state: 'loaded_empty',
          runtime: 'lmstudio',
          checkedAt: 10,
          availability: {
            state: 'unavailable',
            checkedAt: 10,
            message: 'not detected',
          },
          endpoint: 'http://localhost:1234/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [],
        },
      }),
    }));

    await renderAssistantPanel(['ollama'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;

          expect(providerSelect.value).toBe('ollama');
          expect(modelSelect.value).toBe('nomic-embed-text');
        },
        { timeout: 3000 }
      )
    );

    const state = useAssistantPreferencesStore.getState();
    expect(state.getSelectedModel()).toBe('ollama::nomic-embed-text');
  });

  test('includes local runtime detection hint when no providers are configured', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'available',
          checkedAt: 20,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 7,
        },
        lmstudio: {
          state: 'stale',
          checkedAt: 20,
          endpoint: 'http://localhost:1234/v1/models',
          lastSuccessfulAt: 19,
          reason: 'unavailable',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'loaded_non_empty',
          runtime: 'ollama',
          checkedAt: 20,
          availability: {
            state: 'available',
            checkedAt: 20,
            endpoint: 'http://127.0.0.1:11434/v1/models',
            latencyMs: 7,
          },
          endpoint: 'http://127.0.0.1:11434/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'qwen3',
              modelKey: 'ollama::qwen3',
              displayName: 'Qwen3',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: true, embeddings: 'unsupported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'not_applicable' },
            },
            {
              runtime: 'ollama',
              providerId: 'ollama',
              modelId: 'nomic-embed-text',
              modelKey: 'ollama::nomic-embed-text',
              displayName: 'Nomic Embed Text',
              endpoint: 'http://127.0.0.1:11434/v1/models',
              source: 'openai_v1_models',
              freshness: 'live',
              capabilities: { llm: false, embeddings: 'supported' },
              capabilitySource: 'inferred',
              dimensionsKnown: { state: 'known', values: [768], verifiedAt: 20, endpoint: '' },
            },
          ],
        },
        lmstudio: {
          state: 'loaded_empty',
          runtime: 'lmstudio',
          checkedAt: 20,
          availability: {
            state: 'stale',
            checkedAt: 20,
            endpoint: 'http://localhost:1234/v1/models',
            lastSuccessfulAt: 19,
            reason: 'unavailable',
          },
          endpoint: 'http://localhost:1234/v1/models',
          source: 'openai_v1_models',
          freshness: 'live',
          models: [],
        },
      }),
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Detected local runtime: Ollama (2 models) + LM Studio (no models) on localhost.'
          );
        },
        { timeout: 3000 }
      )
    );
  });

  test('includes blocked web policy hint when runtime localhost probing is blocked', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      ...state,
      getLocalRuntimeStatuses: async () => ({
        ollama: {
          state: 'blocked_web',
          checkedAt: 30,
          message: 'Failed to fetch',
        },
        lmstudio: {
          state: 'unavailable',
          checkedAt: 30,
          message: 'not detected',
        },
      }),
      getLocalRuntimeModels: async () => ({
        ollama: {
          state: 'failed',
          runtime: 'ollama',
          checkedAt: 30,
          availability: {
            state: 'blocked_web',
            checkedAt: 30,
            message: 'Failed to fetch',
          },
          message: 'probe blocked',
        },
        lmstudio: {
          state: 'failed',
          runtime: 'lmstudio',
          checkedAt: 30,
          availability: {
            state: 'unavailable',
            checkedAt: 30,
            message: 'not detected',
          },
          message: 'not detected',
        },
      }),
    }));

    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
            'Ollama probe was blocked by browser networking policy.'
          );
        },
        { timeout: 3000 }
      )
    );
  });

  test('allows changing provider and auto-selects default model', async () => {
    const user = userEvent.setup();

    await renderAssistantPanel(['openai', 'anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Change provider to anthropic
    const providerSelect = screen.getByTestId('provider-select');
    await user.selectOptions(providerSelect, 'anthropic');

    // Wait for model to update and panel to remain enabled
    await waitFor(() => {
      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      expect(modelSelect.value).toBe('claude-sonnet-4-5');
      expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
    });
  });

  test('allows changing model for selected provider', async () => {
    const user = userEvent.setup();

    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.5');

    await renderAssistantPanel(['openrouter'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openrouter');
        },
        { timeout: 3000 }
      )
    );

    // Change model
    const modelSelect = screen.getByTestId('model-select');
    await user.selectOptions(modelSelect, 'anthropic/claude-sonnet-4.5');

    // Verify model changed in store
    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.getSelectedModel()).toBe('openrouter::anthropic/claude-sonnet-4.5');
      expect(state.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.5');
    });
  });

  test('preserves selected provider across re-renders', async () => {
    const renderResult = await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );
    const { rerender } = renderResult;

    // Manually select a different provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });

    // Re-render component
    await act(async () => {
      rerender(<AssistantUiPanelWrapper initialProviders={['openai', 'anthropic', 'google']} />);
    });

    // Selection should persist - wait for re-render to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');
    });
  });

  test('starts with first provider when initially loaded', async () => {
    // Start with a single provider
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('anthropic');

          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect.value).toBe('claude-sonnet-4-5');

          expect(screen.getByTestId('panel-disabled')).toHaveTextContent('false');
        },
        { timeout: 3000 }
      )
    );
  });

  test('model selector is disabled when no provider selected', async () => {
    await renderAssistantPanel([], () =>
      waitFor(
        () => {
          const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
          expect(modelSelect).toBeDisabled();
        },
        { timeout: 3000 }
      )
    );
  });

  test('shows correct models for each provider', async () => {
    await renderAssistantPanel(['openai', 'anthropic', 'google'], () =>
      waitFor(
        () => {
          const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
          expect(providerSelect.value).toBe('openai');
        },
        { timeout: 3000 }
      )
    );

    // Check OpenAI default model is available (only models with default: true are enabled)
    const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
    const options = Array.from(modelSelect.options).map((o) => o.value);
    expect(options).toContain('gpt-5.2'); // default model for openai

    // Switch to Google
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'google');

    // Wait for provider switch and model update to complete
    await waitFor(() => {
      const providerSelect = screen.getByTestId('provider-select') as HTMLSelectElement;
      expect(providerSelect.value).toBe('google');

      const modelSelect = screen.getByTestId('model-select') as HTMLSelectElement;
      const options = Array.from(modelSelect.options).map((o) => o.value);
      expect(options).toContain('gemini-3-flash-preview'); // default model for google
      expect(options).not.toContain('gpt-5.2'); // openai model shouldn't be here
    });
  });

  test('persists provider and model selections in store', async () => {
    // Enable an additional model for testing model switching (via DB mock)
    testEnabledModels.add('anthropic/claude-sonnet-4.5');

    await renderAssistantPanel(['openai', 'openrouter'], () =>
      waitFor(() => {
        const state = useAssistantPreferencesStore.getState();
        expect(state.getSelectedProvider()).toBe('openai');
        expect(state.modelsByProvider['openai']).toBe('gpt-5.2');
      })
    );

    // Change provider
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('provider-select'), 'openrouter');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.getSelectedProvider()).toBe('openrouter');
      expect(state.modelsByProvider['openrouter']).toBe('openai/gpt-5.2');
    });

    // Change model (to the model we enabled above)
    await user.selectOptions(screen.getByTestId('model-select'), 'anthropic/claude-sonnet-4.5');

    await waitFor(() => {
      const state = useAssistantPreferencesStore.getState();
      expect(state.modelsByProvider['openrouter']).toBe('anthropic/claude-sonnet-4.5');
    });
  });

  test('disabling the active model calls toggleModel with correct args', async () => {
    const user = userEvent.setup();
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect((screen.getByTestId('provider-select') as HTMLSelectElement).value).toBe('openai');
      })
    );

    const initialCompositeModel = useAssistantPreferencesStore.getState().getSelectedModel();
    if (!initialCompositeModel) {
      throw new Error('expected initial model');
    }

    // Extract just the model name from composite key (format: "provider::model")
    const initialModelName = initialCompositeModel.split('::')[1];
    if (!initialModelName) {
      throw new Error('expected model name in composite key');
    }

    const toggle = screen.getByTestId(
      `model-toggle-openai-${initialModelName}`
    ) as HTMLInputElement;

    // Verify toggle is checked before clicking
    expect(toggle.checked).toBe(true);

    await user.click(toggle);

    // Verify the model was removed from the test enabled set (DB mock)
    expect(testEnabledModels.has(initialModelName)).toBe(false);
  });

  test('loads MCP tools on mount', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            id: 'mcp.tool',
            description: 'Test tool',
            enabled: true,
          },
        ],
      }),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    expect(mcpApi.listTools).toHaveBeenCalled();
    expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT + 1));
  });

  test('handles MCP load failures gracefully', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT));
      })
    );

    expect(mcpApi.listTools).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId('tool-menu-loading')).toHaveTextContent('false');
    });
  });

  test('refreshes MCP tools when requested', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            id: 'mcp.tool',
            enabled: true,
          },
        ],
      }),
    });
    const user = userEvent.setup();

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    await user.click(screen.getByTestId('tool-menu-refresh'));

    await waitFor(() => {
      expect(mcpApi.listTools).toHaveBeenCalledTimes(2);
    });
  });

  test('updates MCP tools when the desktop bridge publishes a tool change event', async () => {
    let handleToolsUpdated: ((tools: Record<string, McpToolDescriptor[]>) => void) | undefined;

    setMcpApi({
      listTools: vi.fn().mockResolvedValue({}),
      onToolsUpdated: vi.fn().mockImplementation((callback) => {
        handleToolsUpdated = callback;
        return () => undefined;
      }),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT));
      })
    );

    expect(handleToolsUpdated).toBeTypeOf('function');

    handleToolsUpdated?.({
      filesystem: [
        {
          id: 'filesystem.list_directory',
          description: 'List directory contents',
          enabled: true,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('tool-menu-item-filesystem.list_directory')).toBeInTheDocument();
    });
    expect(screen.getByTestId('tool-menu-count')).toHaveTextContent(String(NATIVE_TOOL_COUNT + 1));
  });

  test('toggles MCP tools via IPC and reloads', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockResolvedValue({
        'mcp-server': [
          {
            id: 'mcp.tool',
            enabled: false,
          },
        ],
      }),
    });
    const user = userEvent.setup();

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-item-mcp.tool')).toBeInTheDocument();
      })
    );

    await user.click(screen.getByTestId('tool-toggle-mcp.tool'));

    await waitFor(() => {
      expect(mcpApi.enableTools).toHaveBeenCalledWith(['mcp.tool']);
    });

    await waitFor(() => {
      expect(mcpApi.listTools).toHaveBeenCalledTimes(2);
    });
  });

  test('applies root-tree selection updates with default add mode and unsubscribes on unmount', async () => {
    let handler: SelectionUpdateHandler | undefined;
    const unsubscribe = vi.fn();
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return unsubscribe;
      },
    };

    const { unmount } = await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        folderId: 'test-folder',
        filePaths: ['alpha.ts', '/beta.ts', 'alpha.ts'],
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).toHaveBeenCalledWith('test-folder', [
      '/alpha.ts',
      '/beta.ts',
    ]);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('applies preview-context selection updates in remove mode', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onPreviewContextSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onPreviewContextSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        folderId: 'test-folder',
        filePaths: ['/remove-me.ts'],
        mode: 'remove',
      });
    });

    expect(fileExplorerMocks.removeMultipleSelectedFiles).toHaveBeenCalledWith('test-folder', [
      '/remove-me.ts',
    ]);
  });

  test('replace mode preserves other-folder selections and bad keys', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };
    fileExplorerMocks.effectiveSelection = new Set<string>([
      encodeFileSelection('other-folder', '/keep.ts'),
      encodeFileSelection('test-folder', '/drop.ts'),
      'bad-selection-key',
    ]);

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        folderId: 'test-folder',
        filePaths: ['new-file.ts', '/new-file.ts'],
        mode: 'replace',
      });
    });

    expect(fileExplorerMocks.clearSelectionRules).toHaveBeenCalledTimes(1);
    expect(fileExplorerMocks.setSelectedFiles).toHaveBeenCalledTimes(1);
    const nextSelection = fileExplorerMocks.setSelectedFiles.mock.calls[0]?.[0] as
      | Set<string>
      | undefined;
    expect(nextSelection).toBeDefined();
    expect(nextSelection?.has(encodeFileSelection('other-folder', '/keep.ts'))).toBe(true);
    expect(nextSelection?.has('bad-selection-key')).toBe(true);
    expect(nextSelection?.has(encodeFileSelection('test-folder', '/new-file.ts'))).toBe(true);
    expect(nextSelection?.has(encodeFileSelection('test-folder', '/drop.ts'))).toBe(false);
  });

  test('ignores invalid selection update payloads', async () => {
    let handler: SelectionUpdateHandler | undefined;
    (
      window as typeof window & {
        tools?: { onRootTreeSelectionUpdate: (cb: SelectionUpdateHandler) => () => void };
      }
    ).tools = {
      onRootTreeSelectionUpdate: (cb) => {
        handler = cb as SelectionUpdateHandler;
        return vi.fn();
      },
    };

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    act(() => {
      handler?.({
        folderId: '',
        filePaths: [],
      });
    });

    expect(fileExplorerMocks.addMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.removeMultipleSelectedFiles).not.toHaveBeenCalled();
    expect(fileExplorerMocks.setSelectedFiles).not.toHaveBeenCalled();
  });

  test('keeps selected files as tool hints without sending hidden context controls', async () => {
    fileExplorerMocks.effectiveSelection = new Set<string>([
      encodeFileSelection('test-folder', '/alpha.ts'),
      encodeFileSelection('test-folder', '/beta.ts'),
    ]);
    fileExplorerMocks.includeProjectTree = true;
    fileExplorerMocks.tokenCache = {
      cacheVersion: 1,
      getTokenCount: (_folderId: string, path: string) => {
        if (path === '/alpha.ts') {
          return 40;
        }
        if (path === '/beta.ts') {
          return 60;
        }
        return 0;
      },
    };
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('token_count')) {
        return {
          rows: [
            { path: '/alpha.ts', tokenCount: 200 },
            { path: '/beta.ts', tokenCount: 120 },
          ],
        };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ count: '5' }] };
      }
      return { rows: [] };
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        const contextMenu = readPanelContextMenu();
        expect(requestData['selectionFilePaths']).toEqual(['/alpha.ts', '/beta.ts']);
        expect(requestData['selectionFolderId']).toBe('test-folder');
        expect(requestData['workspaceRootPath']).toBe('/tmp/test-workspace');
        expect(requestData['workspaceIndexEmbeddingSetId']).toBe('managed-set-1');
        expect(requestData['workspaceIndexingEnabled']).toBe(true);
        expect(requestData['workspaceIndexingMode']).toBe('root-folder-cache');
        expect(requestData['workspaceIndexingPaused']).toBe(false);
        expect(requestData['embeddingSetId']).toBeUndefined();
        expect(requestData['tokenBudget']).toBeUndefined();
        expect(requestData['contextTokenCount']).toBeUndefined();
        expect(requestData['includeFileReport']).toBeUndefined();
        expect(requestData['includeProjectTree']).toBeUndefined();
        expect(contextMenu).toEqual({});
      })
    );
  });

  test('builds model and provider options for openai settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 513.9,
          reasoningEffort: 'high',
          reasoningSummary: 'auto',
        },
      },
    }));

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['modelSettings']).toEqual({ maxOutputTokens: 513 });
        expect(requestData['providerOptions']).toEqual({
          openai: {
            reasoningEffort: 'high',
            reasoningSummary: 'auto',
          },
        });
      })
    );
  });

  test('uses per-thread draft settings instead of global provider settings for requests', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));
    useAssistantThreadStore.getState().setThreadDraftRuntime('thread-existing', {
      provider: 'openai',
      model: 'gpt-5.2',
      modelSettings: { maxOutputTokens: 2048 },
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });

    await renderAssistantThreadPanel(['openai'], 'thread-existing', () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['modelSettings']).toEqual({ maxOutputTokens: 2048 });
        expect(requestData['providerOptions']).toEqual({
          openai: { reasoningEffort: 'low' },
        });
      })
    );
  });

  test('stores provider setting changes as per-thread draft runtime', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));

    await renderAssistantThreadPanel(['openai'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-change-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5.2',
        modelSettings: { maxOutputTokens: 2048 },
        providerOptions: { openai: { reasoningEffort: 'low' } },
      })
    );
    expect(useAssistantPreferencesStore.getState().providerSettings['openai']).toEqual(
      expect.objectContaining({
        maxOutputTokens: 512,
        reasoningEffort: 'high',
      })
    );
  });

  test('stores provider setting changes globally when no thread prop is mounted', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          ...state.providerSettings['openai'],
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('provider-settings-change-openai'));
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId).toEqual({});
    expect(useAssistantPreferencesStore.getState().providerSettings['openai']).toEqual(
      expect.objectContaining({
        maxOutputTokens: 2048,
        reasoningEffort: 'low',
      })
    );
  });

  test('stores model changes as per-thread draft runtime instead of global preferences', async () => {
    const user = userEvent.setup();
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    await renderAssistantThreadPanel(['openai', 'anthropic'], 'thread-existing', async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByTestId('provider-select'), 'anthropic');
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe('openai::gpt-5.2');
  });

  test('does not expose assistant runtime test hooks outside desktop E2E mode', async () => {
    (window as typeof window & { desktopLifecycle?: { isTestMode?: boolean } }).desktopLifecycle = {
      isTestMode: false,
    };

    await renderAssistantThreadPanel(['openai'], 'thread-existing', () =>
      waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      })
    );

    expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeUndefined();
  });

  test('registers assistant runtime test hooks only during desktop E2E mode', async () => {
    (window as typeof window & { desktopLifecycle?: { isTestMode?: boolean } }).desktopLifecycle = {
      isTestMode: true,
    };
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    const { unmount } = await renderAssistantThreadPanel(
      ['openai', 'anthropic'],
      'thread-existing',
      () =>
        waitFor(() => {
          expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeDefined();
        })
    );

    act(() => {
      window.__brainstrikeAssistantRuntimeTestHooks__?.setCurrentThreadModel(
        'anthropic::claude-sonnet-4-5'
      );
    });

    expect(useAssistantThreadStore.getState().draftRuntimeByThreadId['thread-existing']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(useAssistantPreferencesStore.getState().selectedModel).toBe(
      'anthropic::claude-sonnet-4-5'
    );

    unmount();
    expect(window.__brainstrikeAssistantRuntimeTestHooks__).toBeUndefined();
  });

  test('includes workspace-scoped Mastra memory context in assistant requests', async () => {
    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          threadId: 'thread-existing',
          resourceId: '/tmp/test-workspace',
          memoryOptions: {
            lastMessages: 40,
            workingMemory: { enabled: true, scope: 'resource' },
          },
        });
      })
    );
  });

  test('disables hosted memory requests when the runtime has no Mastra memory backend', async () => {
    Reflect.deleteProperty(window, 'assistant');

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toBeUndefined();
        expect(screen.getByTestId('panel-disabled')).toHaveTextContent('true');
        expect(screen.getByTestId('disabled-reason')).toHaveTextContent(
          'Assistant memory for hosted providers requires the desktop assistant backend.'
        );
      })
    );
  });

  test('passes assistant memory preferences into Mastra runtime requests', async () => {
    useAssistantMemoryPreferencesStore.setState({
      observationalMemory: {
        enabled: true,
        modelTarget: 'anthropic/claude-haiku-4-5',
        scope: 'resource',
        messageTokens: 18_000,
        observationTokens: 36_000,
        retrievalMode: 'messages',
      },
      semanticRecall: {
        enabled: false,
        embeddingModelTarget: 'openai/text-embedding-3-small',
        scope: 'resource',
        topK: 5,
        messageRange: 2,
      },
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['memory']).toMatchObject({
          memorySettings: {
            observationalMemory: {
              enabled: true,
              modelTarget: 'anthropic/claude-haiku-4-5',
              scope: 'resource',
              messageTokens: 18_000,
              observationTokens: 36_000,
              retrievalMode: 'messages',
            },
            semanticRecall: {
              enabled: false,
              embeddingModelTarget: 'openai/text-embedding-3-small',
              scope: 'resource',
              topK: 5,
              messageRange: 2,
            },
          },
        });
      })
    );
  });

  test('does not rewrite Mastra thread metadata just by selecting a thread', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE mastra_threads'))
    ).toBe(false);
  });

  test('creates immutable run records and attaches run IDs to prepared requests', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-00000000000d');
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
      providerSettings: {
        ...state.providerSettings,
        openai: {
          maxOutputTokens: 512,
          reasoningEffort: 'high',
        },
      },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    await waitFor(() => {
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO brainstrike_assistant_thread_runs'),
        expect.arrayContaining([
          'run-00000000-0000-4000-8000-00000000000d',
          '/tmp/test-workspace',
          'thread-existing',
          'openai',
          'gpt-5.2',
          JSON.stringify({ maxOutputTokens: 512 }),
          JSON.stringify({ openai: { reasoningEffort: 'high' } }),
          'hosted',
          'running',
        ])
      );
    });
    expect(
      mockDb.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE mastra_threads'))
    ).toBe(false);
    expect(preparedRequestDataLog[0]?.['memory']).toMatchObject({
      threadId: 'thread-existing',
      resourceId: '/tmp/test-workspace',
      runId: 'run-00000000-0000-4000-8000-00000000000d',
    });
    const insertCall = mockDb.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_thread_runs')
    );
    expect(insertCall?.[1]?.[6]).toContain('"reasoningEffort":"high"');
    expect(insertCall?.[1]?.[5]).toContain('"maxOutputTokens":512');
    uuidSpy.mockRestore();
  });

  test('completes prepared run records with terminal statuses', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-4000-8000-000000000012');
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('complete-prepared-request-success'));
      await user.click(screen.getByTestId('complete-prepared-request-failure'));
      await user.click(screen.getByTestId('complete-prepared-request-without-run'));
    });

    const updateCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE brainstrike_assistant_thread_runs')
    );
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000012', 'completed', null])
    );
    expect(updateCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000012', 'failed', 'model failed'])
    );
    uuidSpy.mockRestore();
  });

  test('creates a fresh run record for each prepared request', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000010')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000011');
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    const runInsertCalls = mockDb.query.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO brainstrike_assistant_thread_runs')
    );

    expect(runInsertCalls).toHaveLength(2);
    expect(runInsertCalls[0]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000010'])
    );
    expect(runInsertCalls[1]?.[1]).toEqual(
      expect.arrayContaining(['run-00000000-0000-4000-8000-000000000011'])
    );
    expect(preparedRequestDataLog[0]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-000000000010',
    });
    expect(preparedRequestDataLog[1]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-000000000011',
    });
    uuidSpy.mockRestore();
  });

  test('retries thread run creation after a transient failure', async () => {
    const user = userEvent.setup();
    const uuidSpy = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000000e')
      .mockReturnValueOnce('00000000-0000-4000-8000-00000000000f');
    let runInsertCount = 0;
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
      if (sql.includes('INSERT INTO brainstrike_assistant_thread_runs')) {
        runInsertCount += 1;
        if (runInsertCount === 1) {
          throw new Error('temporary run insert failure');
        }
        return {
          rows: [
            {
              id: 'run-00000000-0000-4000-8000-00000000000f',
              resource_id: '/tmp/test-workspace',
              thread_id: 'thread-existing',
              provider: 'openai',
              model: 'gpt-5.2',
              model_settings: null,
              provider_options: null,
              runtime_kind: 'hosted',
              status: 'running',
              error: null,
              started_at: new Date('2026-04-22T10:00:00Z'),
              completed_at: null,
              created_at: new Date('2026-04-22T10:00:00Z'),
              updated_at: new Date('2026-04-22T10:00:00Z'),
            },
          ],
        };
      }
      return { rows: [] };
    });
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'openai',
      selectedModel: 'openai::gpt-5.2',
      modelsByProvider: { ...state.modelsByProvider, openai: 'gpt-5.2' },
    }));

    await renderAssistantPanel(['openai'], async () => {
      await waitFor(() => {
        expect(screen.getByTestId('assistant-ui-panel')).toBeInTheDocument();
      });
      await user.click(screen.getByTestId('prepare-thread-request'));
      await user.click(screen.getByTestId('prepare-thread-request'));
    });

    expect(preparedRequestDataLog[0]).toEqual({ error: 'temporary run insert failure' });
    expect(preparedRequestDataLog[1]?.['memory']).toMatchObject({
      runId: 'run-00000000-0000-4000-8000-00000000000f',
    });
    expect(runInsertCount).toBe(2);
    uuidSpy.mockRestore();
  });

  test('builds provider options for anthropic settings', async () => {
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'anthropic',
      selectedModel: 'anthropic::claude-sonnet-4-5',
      modelsByProvider: { ...state.modelsByProvider, anthropic: 'claude-sonnet-4-5' },
      providerSettings: {
        ...state.providerSettings,
        anthropic: {
          ...state.providerSettings['anthropic'],
          anthropicEffort: 'medium',
          anthropicThinkingBudgetTokens: 422.2,
        },
      },
    }));
    await renderAssistantPanel(['anthropic'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['providerOptions']).toEqual({
          anthropic: {
            effort: 'medium',
            thinking: {
              type: 'enabled',
              budgetTokens: 422,
            },
          },
        });
      })
    );
  });

  test('drops invalid google thinking level for gemini-3-pro-preview and opens tool settings', async () => {
    testEnabledModels.add('gemini-3-pro-preview');
    useAssistantPreferencesStore.setState((state) => ({
      selectedProvider: 'google',
      selectedModel: 'google::gemini-3-pro-preview',
      modelsByProvider: { ...state.modelsByProvider, google: 'gemini-3-pro-preview' },
      providerSettings: {
        ...state.providerSettings,
        google: {
          ...state.providerSettings['google'],
          googleThinkingLevel: 'minimal',
        },
      },
    }));
    usePanelLayoutStore.setState({ activeTab: 'explorer' });
    window.location.hash = '';

    const user = userEvent.setup();
    await renderAssistantPanel(['google'], () =>
      waitFor(() => {
        const requestData = readPanelRequestData();
        expect(requestData['providerOptions']).toBeUndefined();
      })
    );

    await user.click(screen.getByTestId('tool-menu-open-settings'));
    expect(usePanelLayoutStore.getState().activeTab).toBe('settings');
    expect(window.location.hash).toBe('#settings/ai-tools');
  });

  test('does not update state after unmount during MCP load', async () => {
    let resolveList: ((value: Record<string, McpToolDescriptor[]>) => void) | undefined;
    const listPromise = new Promise<Record<string, McpToolDescriptor[]>>((resolve) => {
      resolveList = resolve;
    });
    setMcpApi({
      listTools: vi.fn().mockReturnValue(listPromise),
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <AssistantUiPanelWrapper initialProviders={['openai'] as SupportedProvider[]} />
    );

    unmount();

    await act(async () => {
      resolveList?.({
        'mcp-server': [
          {
            id: 'mcp.tool',
            enabled: true,
          },
        ],
      });
      await listPromise;
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
