import type { LocalRuntimeModelCatalogState, SupportedProvider } from '@brainstrike/agent/client';
import {
  __resetAssistantPreferencesStoreForTests,
  useAssistantPreferencesStore,
  usePanelLayoutStore,
} from '@brainstrike/preferences';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';

const { fileExplorerMocks, testEnabledModels } = vi.hoisted(() => ({
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
    selectedProvider: SupportedProvider | null;
    selectedModel: string | null;
    modelsByProvider: Record<string, string>;
    enabledModelsByProvider: Record<string, string[]>;
    providerSettings: Record<string, Record<string, unknown>>;
    setModel: (compositeKey: string) => void;
    clearModel: () => void;
    getAvailableProviders: () => Promise<SupportedProvider[]>;
    getLocalRuntimeStatuses: () => Promise<{
      ollama: { state: 'unavailable'; checkedAt: number; message: string };
      lmstudio: { state: 'unavailable'; checkedAt: number; message: string };
    }>;
    getLocalRuntimeModels: () => Promise<{
      ollama: LocalRuntimeModelCatalogState;
      lmstudio: LocalRuntimeModelCatalogState;
    }>;
    getSelectedProvider: () => SupportedProvider | null;
    getSelectedModel: () => string | null;
    setProviderSettings: (providerId: string, updates: Record<string, unknown>) => void;
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
    useAssistantPreferencesStore,
    useEnsureModelRegistry: vi.fn(),
    useModelRegistryStore,
    useNativeToolPreferencesStore,
    usePanelLayoutStore,
    useSecretsStore,
    useVectorStatusUIStore,
  };
});

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// Mock the DB hook
vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: vi.fn(() => mockDb),
  useDbInitializing: vi.fn(() => false),
  useDbProviderError: vi.fn(() => null),
}));

vi.mock('@brainstrike/file-explorer-ui', () => {
  const store = (
    selector?: (state: {
      tokenBudget: number;
      currentFolderId: string | null;
      rootDirectoryHandle: { path: string; name: string } | null;
      includeProjectTree: boolean;
      setTokenBudget: (budget: number) => void;
      setIncludeProjectTree: (value: boolean) => void;
      setSelectedFiles: (files: ReadonlySet<string>) => void;
      addMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
      removeMultipleSelectedFiles: (folderId: string, paths: string[]) => void;
      clearSelectionRules: () => void;
    }) => unknown
  ) => {
    const state = {
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
    };
    return selector ? selector(state) : state;
  };
  return {
    useSelectionManager: () => ({ effectiveSelection: fileExplorerMocks.effectiveSelection }),
    useFileExplorerStoreContext: () => store,
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

// Mock the AssistantUiPanel component
vi.mock('@brainstrike/ui/assistant-ui-panel', () => ({
  AssistantUiPanel: ({
    providerGroups = [],
    selectedProvider,
    selectedModel,
    onModelChange,
    onModelToggle,
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
  mockDb.query.mockResolvedValue({ rows: [] });
  window.localStorage.removeItem('brainstrike.assistant.include-file-report.v1');
});

afterEach(() => {
  __resetAssistantPreferencesStoreForTests();
  Reflect.deleteProperty(window, 'tools');
  Reflect.deleteProperty(window, 'mcp');
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

interface McpToolDescriptor {
  id: string;
  description?: string;
  enabled: boolean;
}

interface McpApi {
  listTools: () => Promise<Record<string, McpToolDescriptor[]>>;
  enableTools?: (toolIds: string[]) => Promise<void>;
  disableTools?: (toolIds: string[]) => Promise<void>;
}

const setMcpApi = (overrides: Partial<McpApi> = {}) => {
  const api: McpApi = {
    listTools: vi.fn().mockResolvedValue({}),
    enableTools: vi.fn().mockResolvedValue(undefined),
    disableTools: vi.fn().mockResolvedValue(undefined),
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
    expect(screen.getByTestId('tool-menu-count')).toHaveTextContent('1');
  });

  test('handles MCP load failures gracefully', async () => {
    const mcpApi = setMcpApi({
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await renderAssistantPanel(['openai'], () =>
      waitFor(() => {
        expect(screen.getByTestId('tool-menu-count')).toHaveTextContent('0');
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

  test('computes context token count using DB totals, cache totals, and tree estimate', async () => {
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
        const contextMenu = readPanelContextMenu();
        expect(contextMenu['contextTokenCount']).toBe(360);
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
