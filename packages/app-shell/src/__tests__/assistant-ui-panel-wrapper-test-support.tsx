import { __resetAssistantPreferencesStoreForTests } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { __resetWorkspaceCollectionSyncStatusStoreForTests } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import {
  type ProviderId,
  type SupportedProvider,
  WEB_NATIVE_TOOL_IDS,
} from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { AssistantUiPanelProps } from '@brainstrike/assistant-ui';
import type {
  LocalRuntimeAvailabilityState,
  LocalRuntimeModelCatalogState,
} from '@brainstrike/local-runtime';
import type { AssistantSelectionUpdatePayload } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { __resetAssistantForegroundActivityForTests } from '../assistant-foreground-activity';
import { AssistantUiPanelWrapper } from '../assistant-ui-panel-wrapper';
import { AssistantProviderSourceProvider } from '../hooks/assistant-provider-source';
import { __resetConfiguredAssistantProvidersForTests } from '../hooks/use-configured-assistant-providers';
import { type McpToolsCapability, McpToolsCapabilityProvider } from '../mcp-tools-capability';

export const NATIVE_TOOL_COUNT = WEB_NATIVE_TOOL_IDS.length;
export const delegatedPanelCallbacks: {
  onDelegatedConversation: AssistantUiPanelProps['onDelegatedConversation'];
  onEnableModel: AssistantUiPanelProps['onEnableModel'];
  onRunningChange: AssistantUiPanelProps['onRunningChange'];
  onRuntimeReady: AssistantUiPanelProps['onRuntimeReady'];
} = {
  onDelegatedConversation: undefined,
  onEnableModel: undefined,
  onRunningChange: undefined,
  onRuntimeReady: undefined,
};

const { hasDesktopLlmHostMock } = vi.hoisted(() => ({
  hasDesktopLlmHostMock: vi.fn((): boolean => false),
}));

const { initializeProviderModelDefaultsMock } = vi.hoisted(() => ({
  initializeProviderModelDefaultsMock: vi.fn(async () => 'preserved' as const),
}));

// BST-1113 Task 4: the wrapper's changeset lifecycle-refresh glue calls
// `useChangeset` — no selection UI exists yet (W4), so the wrapper always
// passes a null changeset. Mocked here (not the real bridge-backed hook) so
// the wrapper suite can assert the run-finished/run-failed composition
// directly, independent of `use-changeset.ts`'s own unit coverage.
const { changesetRefreshMock, useChangesetMock } = vi.hoisted(() => ({
  changesetRefreshMock: vi.fn(async () => undefined),
  useChangesetMock: vi.fn(),
}));
useChangesetMock.mockImplementation(() => ({
  available: false,
  error: null,
  fileDiff: vi.fn(),
  refresh: changesetRefreshMock,
  view: null,
}));
vi.mock('../changes/use-changeset', () => ({
  useChangeset: (...args: unknown[]) => useChangesetMock(...args),
}));

const { fileExplorerMocks, preparedRequestDataLog, testEnabledModels } = vi.hoisted(() => ({
  fileExplorerMocks: {
    addMultipleSelectedFiles: vi.fn<(folderId: string, paths: string[]) => void>(),
    currentFolderId: 'test-folder' as string | null,
    effectiveSelection: new Set<string>(),
    includeProjectTree: false,
    removeMultipleSelectedFiles: vi.fn<(folderId: string, paths: string[]) => void>(),
    resetSelectionToExplicit: vi.fn<() => void>(),
    rootDirectoryHandle: {
      name: 'test-workspace',
      path: '/tmp/test-workspace',
    } as { path: string; name: string } | null,
    setIncludeProjectTree: vi.fn<(value: boolean) => void>(),
    setSelectedFiles: vi.fn<(files: ReadonlySet<string>) => void>(),
    setTapestryRangesForKey: vi.fn<(key: string, ranges: unknown[]) => void>(),
    setTokenBudget: vi.fn<(budget: number) => void>(),
    tapestryRangesByKey: {} as Record<string, unknown[]>,
    tokenBudget: 100_000,
    tokenCache: null as null | {
      cacheVersion: number;
      getTokenCount: (folderId: string, path: string) => number | undefined;
    },
    workspaceContextSnapshot: null as null | Record<string, unknown>,
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

// Build the related lightweight Zustand doubles once, then expose only the
// explicit app-state subpaths used by the wrapper under test.
vi.mock('@brainstrike/app-state/stores/assistant-preferences-store', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@brainstrike/app-state/stores/assistant-preferences-store')
    >();
  const { create } = await import('zustand');

  const buildEnabledModelsByProvider = (): Record<string, string[]> => ({
    anthropic: testEnabledModels.has('claude-sonnet-4-6') ? ['claude-sonnet-4-6'] : [],
    google: [
      testEnabledModels.has('gemini-3.5-flash') ? 'gemini-3.5-flash' : undefined,
      testEnabledModels.has('gemini-3.1-pro-preview') ? 'gemini-3.1-pro-preview' : undefined,
    ].filter((modelId): modelId is string => Boolean(modelId)),
    openai: testEnabledModels.has('gpt-5.2') ? ['gpt-5.2'] : [],
    openrouter: [
      testEnabledModels.has('openai/gpt-5.2') ? 'openai/gpt-5.2' : undefined,
      testEnabledModels.has('anthropic/claude-sonnet-4.6')
        ? 'anthropic/claude-sonnet-4.6'
        : undefined,
      testEnabledModels.has('google/gemini-3.5-flash') ? 'google/gemini-3.5-flash' : undefined,
      // Text-only route (vision: 'unsupported' in the static registry) for
      // composer attachment gating tests; opt in via testEnabledModels.
      testEnabledModels.has('qwen/qwen3-coder-next') ? 'qwen/qwen3-coder-next' : undefined,
    ].filter((modelId): modelId is string => Boolean(modelId)),
  });

  const buildRegistryModels = () => [
    {
      capabilities: { type: 'llm' as const },
      id: 'gpt-5.2',
      isEnabled: testEnabledModels.has('gpt-5.2'),
      providerId: 'openai',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'claude-sonnet-4-6',
      isEnabled: testEnabledModels.has('claude-sonnet-4-6'),
      providerId: 'anthropic',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'gemini-3.5-flash',
      isEnabled: testEnabledModels.has('gemini-3.5-flash'),
      providerId: 'google',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'gemini-3.1-pro-preview',
      isEnabled: testEnabledModels.has('gemini-3.1-pro-preview'),
      providerId: 'google',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'openai/gpt-5.2',
      isEnabled: testEnabledModels.has('openai/gpt-5.2'),
      providerId: 'openrouter',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'anthropic/claude-sonnet-4.6',
      isEnabled: testEnabledModels.has('anthropic/claude-sonnet-4.6'),
      providerId: 'openrouter',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'google/gemini-3.5-flash',
      isEnabled: testEnabledModels.has('google/gemini-3.5-flash'),
      providerId: 'openrouter',
    },
    {
      capabilities: { type: 'llm' as const },
      id: 'qwen/qwen3-coder-next',
      isEnabled: testEnabledModels.has('qwen/qwen3-coder-next'),
      providerId: 'openrouter',
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
    getLocalRuntimeStatuses: () => Promise<
      Record<'lmstudio' | 'ollama', LocalRuntimeAvailabilityState>
    >;
    getSelectedModel: () => string | null;
    getSelectedProvider: () => SupportedProvider | null;
    modelsByProvider: Record<string, string>;
    providerSettings: Record<string, Record<string, unknown>>;
    recentModels: string[];
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
    clearModel: () => {
      set({
        selectedModel: null,
        selectedProvider: null,
      });
    },
    enabledModelsByProvider: buildEnabledModelsByProvider(),
    getAvailableProviders: async () => ['openai', 'anthropic', 'google', 'openrouter'],
    getLocalRuntimeModels: async () => ({
      lmstudio: {
        availability: {
          checkedAt: 0,
          endpoint: 'http://localhost:1234/v1/models',
          latencyMs: 0,
          state: 'available',
        },
        checkedAt: 0,
        endpoint: 'http://localhost:1234/v1/models',
        freshness: 'live',
        models: [],
        runtime: 'lmstudio',
        source: 'openai_v1_models',
        state: 'loaded_empty',
      },
      ollama: {
        availability: {
          checkedAt: 0,
          endpoint: 'http://127.0.0.1:11434/v1/models',
          latencyMs: 0,
          state: 'available',
        },
        checkedAt: 0,
        endpoint: 'http://127.0.0.1:11434/v1/models',
        freshness: 'live',
        models: [],
        runtime: 'ollama',
        source: 'openai_v1_models',
        state: 'loaded_empty',
      },
    }),
    getLocalRuntimeStatuses: async () => ({
      lmstudio: {
        checkedAt: 0,
        message: 'not detected',
        state: 'unavailable',
      },
      ollama: {
        checkedAt: 0,
        message: 'not detected',
        state: 'unavailable',
      },
    }),
    getSelectedModel: () => get().selectedModel,
    getSelectedProvider: () => get().selectedProvider,
    modelsByProvider: {},
    providerSettings: {},
    recentModels: [],
    selectedModel: null,
    selectedProvider: null,
    setModel: (compositeKey: string) => {
      const [provider, model] = compositeKey.split('::');
      if (!(provider && model)) {
        return;
      }
      set((state) => ({
        modelsByProvider: { ...state.modelsByProvider, [provider]: model },
        recentModels: [
          compositeKey,
          ...state.recentModels.filter((entry) => entry !== compositeKey),
        ].slice(0, 5),
        selectedModel: compositeKey,
        selectedProvider: provider as SupportedProvider,
      }));
    },
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
      messageTokens: 30_000,
      modelTarget: 'openai/gpt-5.4-mini',
      observationTokens: 40_000,
      retrievalMode: 'off',
      scope: 'thread',
    },
    semanticRecall: {
      embeddingModelTarget: 'openai/text-embedding-3-small',
      enabled: false,
      messageRange: 2,
      scope: 'resource',
      topK: 5,
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
    toolStates: {},
  }));

  const useSecretsStore = create<{
    notifySecretsChanged: () => void;
    secretsVersion: number;
  }>((set) => ({
    notifySecretsChanged: () => set((state) => ({ secretsVersion: state.secretsVersion + 1 })),
    secretsVersion: 0,
  }));

  const useVectorStatusUIStore = <T,>(
    selector: (state: { activeEmbeddingSetId: string | null }) => T
  ): T => selector({ activeEmbeddingSetId: null });

  const useModelRegistryStore = <T,>(
    selector: (state: {
      models: ReturnType<typeof buildRegistryModels>;
      hasLoaded: boolean;
      error: Error | null;
      initializeProviderModelDefaults: typeof initializeProviderModelDefaultsMock;
      toggleModel: (_db: unknown, modelId: string, enabled: boolean) => void;
    }) => T
  ): T =>
    selector({
      error: null,
      hasLoaded: true,
      initializeProviderModelDefaults: initializeProviderModelDefaultsMock,
      models: buildRegistryModels(),
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
      enabledModelsByProvider: buildEnabledModelsByProvider(),
      modelsByProvider: {},
      providerSettings: {},
      recentModels: [],
      selectedModel: null,
      selectedProvider: null,
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
    useSecretsStore.setState({ secretsVersion: 0 });
  };

  const usePanelLayoutStore = create<{
    activeTab: string;
    openSettings: () => void;
    setActiveTab: (tab: string) => void;
  }>((set) => ({
    activeTab: 'explorer',
    openSettings: () => set({ activeTab: 'settings' }),
    setActiveTab: (tab: string) => set({ activeTab: tab }),
  }));

  return {
    __resetAssistantPreferencesStoreForTests,
    AvailableProviderDiscoveryError: actual.AvailableProviderDiscoveryError,
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

vi.mock('@brainstrike/app-state/hooks/use-model-registry', async () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('@brainstrike/app-state/stores/assistant-memory-preferences-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useAssistantMemoryPreferencesStore: unknown };
  return {
    useAssistantMemoryPreferencesStore: preferences.useAssistantMemoryPreferencesStore,
  };
});

vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useBackgroundIndexingPreferencesStore: unknown };
  return {
    useBackgroundIndexingPreferencesStore: preferences.useBackgroundIndexingPreferencesStore,
  };
});

vi.mock('@brainstrike/app-state/stores/model-registry-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useModelRegistryStore: unknown };
  return {
    useModelRegistryStore: preferences.useModelRegistryStore,
  };
});

vi.mock('@brainstrike/app-state/stores/native-tool-preferences-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useNativeToolPreferencesStore: unknown };
  return {
    useNativeToolPreferencesStore: preferences.useNativeToolPreferencesStore,
  };
});

vi.mock('@brainstrike/app-state/stores/panel-layout-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { usePanelLayoutStore: unknown };
  return {
    usePanelLayoutStore: preferences.usePanelLayoutStore,
  };
});

vi.mock('@brainstrike/app-state/stores/secrets-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useSecretsStore: unknown };
  return {
    useSecretsStore: preferences.useSecretsStore,
  };
});

vi.mock('@brainstrike/app-state/stores/vector-status-ui-store', async () => {
  const preferences = (await import(
    '@brainstrike/app-state/stores/assistant-preferences-store'
  )) as unknown as { useVectorStatusUIStore: unknown };
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

const { toastSpy } = vi.hoisted(() => ({
  toastSpy: vi.fn(),
}));

export { toastSpy };

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
}));

const { toggleModelEnabledMock } = vi.hoisted(() => ({
  toggleModelEnabledMock: vi.fn(async () => true),
}));

export { toggleModelEnabledMock };

vi.mock('@brainstrike/settings-ui/settings/models/use-model-toggle', () => ({
  useModelToggle: () => ({ busyModelIds: new Set<string>(), toggle: toggleModelEnabledMock }),
}));

// Mock the DB hook
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  // Quick-open / file-mention shared query constants (useFileMentions).
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
  useDbInitializing: vi.fn(() => false),
  useDbProviderError: vi.fn(() => null),
  // Copy-debug-bundle binding (useDebugBundleBinding) reads this directly.
  useOptionalPGliteDatabase: vi.fn(() => mockDb),
  usePGliteDatabase: vi.fn(() => mockDb),
  // The OM segment live query (useObservationalMemoryRow) and the "@" file
  // mention query (useFileMentions) — inert in these tests (no rows, not
  // loading) so neither runs a real subscription.
  usePGliteLiveQuery: vi.fn(() => ({ error: null, loading: false, refresh: vi.fn(), rows: [] })),
}));
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  // Quick-open / file-mention shared query constants (useFileMentions).
  QUICK_OPEN_MAX_LIMIT: 50,
  QUICK_OPEN_NAME_SEARCH_SQL: 'SELECT ... quick-open',
  useDbInitializing: vi.fn(() => false),
  useDbProviderError: vi.fn(() => null),
  // Copy-debug-bundle binding (useDebugBundleBinding) reads this directly.
  useOptionalPGliteDatabase: vi.fn(() => mockDb),
  usePGliteDatabase: vi.fn(() => mockDb),
  // The OM segment live query (useObservationalMemoryRow) and the "@" file
  // mention query (useFileMentions) — inert in these tests (no rows, not
  // loading) so neither runs a real subscription.
  usePGliteLiveQuery: vi.fn(() => ({ error: null, loading: false, refresh: vi.fn(), rows: [] })),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => {
  // The live-refresh subscription (reached via the composer workspace bar's
  // checkout status) reads the REAL event name — mirror git-panel.test.tsx and
  // re-export it rather than hardcoding a drifting copy.
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>();
  // Stable references for the "@" file-mention selectors (useFileMentions reads
  // these via useFileExplorerStoreSelector). A fresh `[]`/`{}` per getState()
  // call would make the selector return a new value every render → re-render
  // churn that re-runs subscription effects (broke the root-tree
  // unsubscribe-once assertion).
  const stableActiveRootIds: string[] = [];
  const stableRootDescriptors: Record<string, unknown> = {};
  const getState = () => ({
    // "@" file-mention gating (useFileMentions) reads these; empty in these
    // tests so the mention query yields no candidates.
    activeRootIds: stableActiveRootIds,
    addMultipleSelectedFiles: fileExplorerMocks.addMultipleSelectedFiles,
    currentFolderId: fileExplorerMocks.currentFolderId,
    includeProjectTree: fileExplorerMocks.includeProjectTree,
    removeMultipleSelectedFiles: fileExplorerMocks.removeMultipleSelectedFiles,
    resetSelectionToExplicit: fileExplorerMocks.resetSelectionToExplicit,
    rootDescriptors: stableRootDescriptors,
    rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle,
    setIncludeProjectTree: fileExplorerMocks.setIncludeProjectTree,
    setSelectedFiles: fileExplorerMocks.setSelectedFiles,
    setTokenBudget: fileExplorerMocks.setTokenBudget,
    tokenBudget: fileExplorerMocks.tokenBudget,
  });

  const store = (selector?: (state: ReturnType<typeof getState>) => unknown) => {
    const state = getState();
    return selector ? selector(state) : state;
  };

  return {
    FILE_EXPLORER_REFRESH_EVENT: actual.FILE_EXPLORER_REFRESH_EVENT,
    useFileExplorerStoreContext: () => store,
    useFileExplorerStoreSelector: (selector: (state: ReturnType<typeof getState>) => unknown) =>
      selector(getState()),
    useFileSystem: () => ({ rootDirectoryHandle: fileExplorerMocks.rootDirectoryHandle }),
    useSelectionManager: () => ({ effectiveSelection: fileExplorerMocks.effectiveSelection }),
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
      endLine: range.endLine,
      startLine: range.startLine - 1,
    }),
    useWorkspaceContextCurationStore,
  };
});

// Mock the assistant local-runtime contract exports used by the wrapper.
vi.mock('@brainstrike/local-runtime', () => {
  const PROVIDER_DEFINITIONS = {
    anthropic: {
      capabilities: { embeddings: false, llm: true, streaming: true },
      displayName: 'Anthropic',
      id: 'anthropic',
      models: [{ default: true, id: 'claude-sonnet-4-6', supportsStreaming: true, type: 'llm' }],
      runtime: 'hosted',
    },
    google: {
      capabilities: { embeddings: true, llm: true, streaming: true },
      displayName: 'Google AI Studio',
      id: 'google',
      models: [
        { default: true, id: 'gemini-3.5-flash', supportsStreaming: true, type: 'llm' },
        { id: 'gemini-3.1-pro-preview', supportsStreaming: true, type: 'llm' },
      ],
      runtime: 'hosted',
    },
    lmstudio: {
      capabilities: { embeddings: true, llm: true, streaming: true },
      displayName: 'LM Studio',
      id: 'lmstudio',
      models: [
        {
          default: true,
          id: 'text-embedding-nomic-embed-text-v1.5',
          supportsStreaming: true,
          type: 'llm',
        },
      ],
      runtime: 'local',
    },
    ollama: {
      capabilities: { embeddings: true, llm: true, streaming: true },
      displayName: 'Ollama',
      id: 'ollama',
      models: [{ default: true, id: 'nomic-embed-text', supportsStreaming: true, type: 'llm' }],
      runtime: 'local',
    },
    openai: {
      capabilities: { embeddings: true, llm: true, streaming: true },
      displayName: 'OpenAI',
      id: 'openai',
      models: [{ default: true, id: 'gpt-5.2', supportsStreaming: true, type: 'llm' }],
      runtime: 'hosted',
    },
    openrouter: {
      capabilities: { embeddings: false, llm: true, streaming: true },
      displayName: 'OpenRouter',
      id: 'openrouter',
      models: [
        { default: true, id: 'openai/gpt-5.2', supportsStreaming: true, type: 'llm' },
        { id: 'anthropic/claude-sonnet-4.6', supportsStreaming: true, type: 'llm' },
        { id: 'google/gemini-3.5-flash', supportsStreaming: true, type: 'llm' },
      ],
      runtime: 'gateway',
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
    getProviderDefinition: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS],
    getProviderDisplayName: (provider: string) => {
      const definition = PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS];
      return definition?.displayName ?? provider;
    },
    getProviderModelDefinitions: (provider: string) =>
      PROVIDER_DEFINITIONS[provider as keyof typeof PROVIDER_DEFINITIONS]?.models ?? [],
    getProviderModels: (provider: string) =>
      PROVIDER_MODELS[provider as keyof typeof PROVIDER_MODELS] ?? [],
    isLoadedRuntimeModelCatalogState: (
      state: LocalRuntimeModelCatalogState | null | undefined
    ): state is Extract<
      LocalRuntimeModelCatalogState,
      { state: 'loaded_non_empty' | 'stale_cached' }
    > => Boolean(state && (state.state === 'loaded_non_empty' || state.state === 'stale_cached')),
    isSupportedProvider: (provider: string) =>
      SUPPORTED_PROVIDERS.includes(provider as keyof typeof PROVIDER_DEFINITIONS),
    listProviders: () => SUPPORTED_PROVIDERS.map((provider) => PROVIDER_DEFINITIONS[provider]),
    PROVIDER_DEFAULT_ENABLED_MODELS,
    PROVIDER_DEFAULT_MODELS,
    PROVIDER_MODELS,
    supportsStandardEmbeddingDimension: (provider: string) => provider !== 'openrouter',
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
// Defaults to no desktop llm-host bridge, which is what web looks like: the
// built-in local provider is withheld. Tests flip the mock to cover a desktop
// host that can actually run it.
vi.mock('@brainstrike/assistant-contract/local-llm-device', async () => {
  const actual = await vi.importActual<
    typeof import('@brainstrike/assistant-contract/local-llm-device')
  >('@brainstrike/assistant-contract/local-llm-device');
  return { ...actual, hasDesktopLlmHost: hasDesktopLlmHostMock };
});

vi.mock('@brainstrike/assistant-ui', async () => ({
  AssistantUiPanel: ({
    onDelegatedConversation,
    onRunningChange,
    onRuntimeReady,
    composerDraftCommand,
    providerGroups = [],
    selectedProvider,
    selectedModel,
    onEnableModel,
    onModelChange,
    onProviderSettingsChange,
    onProviderSettingsValidationChange,
    onThreadRunStart,
    onRunFinished,
    onRunFailed,
    onRunEditActivity,
    completePreparedRequest,
    prepareRequestData,
    contextMenu,
    requestBodyLimitBytes,
    requestData,
    disabled,
    capabilityNotice,
    disabledReason,
    toolMenu,
    onComposerDraftCommandApplied,
    onComposerTextChange,
    attachmentsAvailability,
    historyGeneration,
  }: {
    onDelegatedConversation?: AssistantUiPanelProps['onDelegatedConversation'];
    onRunningChange?: AssistantUiPanelProps['onRunningChange'];
    onRuntimeReady?: AssistantUiPanelProps['onRuntimeReady'];
    composerDraftCommand?: { id: string; mode: 'append' | 'replace'; text: string };
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
    onEnableModel?: AssistantUiPanelProps['onEnableModel'];
    onModelChange?: (compositeKey: string) => void;
    onProviderSettingsChange?: (providerId: string, updates: Record<string, unknown>) => void;
    onProviderSettingsValidationChange?: (reason: string | undefined) => void;
    onThreadRunStart?: () => void;
    onRunFinished?: (event: { runId: string; kind: string }) => void;
    onRunFailed?: (event: { runId: string; kind: string }) => void;
    onRunEditActivity?: (event: {
      runId?: string;
      kind: string;
      metadata?: Record<string, unknown>;
    }) => void;
    completePreparedRequest?: (
      requestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ) => Promise<void> | void;
    prepareRequestData?: () => Promise<Record<string, unknown> | undefined>;
    contextMenu?: Record<string, unknown>;
    // Conversation Rewind's re-hydration counter (BST-1115). Surfaced on the
    // mock's root so the wrapper's wiring is assertable: the real panel folds
    // it into the runtime `key`, which a mock cannot demonstrate.
    historyGeneration?: number;
    requestBodyLimitBytes?: number;
    requestData?: Record<string, unknown>;
    disabled?: boolean;
    capabilityNotice?: string;
    disabledReason?: string;
    toolMenu?: {
      items: Array<{ id: string; enabled: boolean }>;
      isLoading?: boolean;
      onToggleTool?: (toolId: string, enabled: boolean) => void;
      onRefresh?: () => void;
      onOpenSettings?: () => void;
    };
    onComposerDraftCommandApplied?: (commandId: string) => void;
    onComposerTextChange?: (text: string) => void;
    attachmentsAvailability?: { state: 'enabled' } | { reason: string; state: 'disabled' };
  }) => {
    delegatedPanelCallbacks.onDelegatedConversation = onDelegatedConversation;
    delegatedPanelCallbacks.onRunningChange = onRunningChange;
    delegatedPanelCallbacks.onRuntimeReady = onRuntimeReady;
    delegatedPanelCallbacks.onEnableModel = onEnableModel;
    const providers = providerGroups?.flatMap((group) => group.providers) ?? [];
    const currentProvider = providers.find((p) => p.id === selectedProvider);
    const enabledModels = currentProvider?.models.filter((m) => m.enabled) ?? [];

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
      <div data-history-generation={historyGeneration} data-testid="assistant-ui-panel">
        <div data-testid="composer-draft-command">{composerDraftCommand?.id ?? ''}</div>
        <button
          data-testid="apply-composer-draft-command"
          disabled={!composerDraftCommand}
          onClick={() => {
            if (composerDraftCommand) {
              onComposerDraftCommandApplied?.(composerDraftCommand.id);
            }
          }}
          type="button"
        >
          Apply composer draft command
        </button>
        <button
          data-testid="report-composer-text"
          onClick={() => onComposerTextChange?.('Live composer draft')}
          type="button"
        >
          Report composer text
        </button>
        {/* The real panel re-reads history by remounting its runtime; the mock
            exposes the host callback that remount fires so the wrapper's draft
            carry is assertable. */}

        <div data-testid="composer-draft-command-text">{composerDraftCommand?.text ?? ''}</div>
        <div data-testid="composer-draft-command-mode">{composerDraftCommand?.mode ?? ''}</div>
        <button
          data-testid="trigger-run-finished"
          onClick={() => onRunFinished?.({ kind: 'run.finished', runId: 'run-live' })}
          type="button"
        >
          Trigger run finished
        </button>
        <button
          data-testid="trigger-run-started"
          onClick={() => onRunEditActivity?.({ kind: 'run.started', runId: 'run-live-next' })}
          type="button"
        >
          Trigger run started
        </button>
        <button
          data-testid="trigger-edit-tool-completed"
          onClick={() =>
            onRunEditActivity?.({
              kind: 'tool.completed',
              metadata: { toolName: 'brainstrike.writeWorkspaceFile' },
              runId: 'run-live-next',
            })
          }
          type="button"
        >
          Trigger edit tool completed
        </button>
        <button
          data-testid="trigger-run-failed"
          onClick={() => onRunFailed?.({ kind: 'run.failed', runId: 'run-live' })}
          type="button"
        >
          Trigger run failed
        </button>
        <div data-testid="panel-disabled">{String(disabled)}</div>
        <div data-testid="request-body-limit">{requestBodyLimitBytes ?? ''}</div>
        <div data-testid="attachments-availability">
          {JSON.stringify(attachmentsAvailability ?? null)}
        </div>
        <div data-testid="request-data">{JSON.stringify(requestData ?? {})}</div>
        <div data-testid="context-menu">{JSON.stringify(contextMenu ?? {})}</div>
        {disabledReason && <div data-testid="disabled-reason">{disabledReason}</div>}
        {capabilityNotice && <div data-testid="capability-notice">{capabilityNotice}</div>}
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
          data-testid="provider-settings-invalid"
          onClick={() =>
            onProviderSettingsValidationChange?.(
              'Output limit exceeds the 65,535 maximum from OpenRouter live.'
            )
          }
          type="button"
        >
          Report invalid provider settings
        </button>
        <button
          data-testid="provider-settings-valid"
          onClick={() => onProviderSettingsValidationChange?.(undefined)}
          type="button"
        >
          Clear provider settings validation
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
  // Passthrough doubles for the real context providers — these tests render
  // the mocked AssistantUiPanel, which never renders the budget chip, so the
  // guardrail context is never read; the provider just mounts its children.
  BudgetGuardrailProvider: ({ children }: { children: ReactNode }) => children,
  // Same passthrough rationale: the mocked panel never renders the
  // copy-debug-bundle button, so the debug-bundle context is never read.
  DebugBundleProvider: ({ children }: { children: ReactNode }) => children,
  DelegatedApprovalOwnerContext: (await import('react')).createContext(null),
  // Same passthrough rationale as BudgetGuardrailProvider: the mocked panel
  // never renders a verdict control, so the verdict context is never read.
  RunVerdictProvider: ({ children }: { children: ReactNode }) => children,
  SubagentConversationNavigationContext: (await import('react')).createContext<
    ((threadId: string) => void) | null
  >(null),
  SubagentConversationPresentationContext: (await import('react')).createContext(null),
  SubagentInvocationResolverContext: (await import('react')).createContext(null),
  SubagentLiveInvocationContext: (await import('react')).createContext(null),
  ThreadMessageNavigationContext: (await import('react')).createContext(null),
  ToolApprovalGrantProvider: ({ children }: { children: ReactNode }) => children,
  // The wrapper reads the usage store both as a hook (selector at render time)
  // and via getState() inside the usage/live-sum callbacks + the
  // thread-selection clear effect (BST-953). The mock supports both: the
  // selector receives an empty usage map and getState exposes every action the
  // wrapper calls.
  useContextUsageStore: Object.assign(
    (selector: (state: { usageByThread: Record<string, unknown> }) => unknown) =>
      selector({ usageByThread: {} }),
    {
      getState: () => ({
        clearBreakdown: () => {},
        clearLiveRunUsage: () => {},
        recordBreakdown: () => {},
        recordLiveStepUsage: () => {},
        recordUsage: () => {},
      }),
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
  toastSpy.mockClear();
  toggleModelEnabledMock.mockClear();
  toggleModelEnabledMock.mockResolvedValue(true);
  resetTestEnabledModels();
  __resetConfiguredAssistantProvidersForTests();
  __resetAssistantPreferencesStoreForTests();
  __resetAssistantForegroundActivityForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
  useAssistantComposerCommandStore.getState().reset();
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
    name: 'test-workspace',
    path: '/tmp/test-workspace',
  };
  fileExplorerMocks.tokenBudget = 100_000;
  fileExplorerMocks.workspaceContextSnapshot = null;
  fileExplorerMocks.tapestryRangesByKey = {};
  fileExplorerMocks.addMultipleSelectedFiles.mockReset();
  fileExplorerMocks.resetSelectionToExplicit.mockReset();
  fileExplorerMocks.removeMultipleSelectedFiles.mockReset();
  fileExplorerMocks.setTapestryRangesForKey.mockReset();
  fileExplorerMocks.setIncludeProjectTree.mockReset();
  fileExplorerMocks.setSelectedFiles.mockReset();
  fileExplorerMocks.setTokenBudget.mockReset();
  mockDb.query.mockReset();
  initializeProviderModelDefaultsMock.mockClear();
  mockDb.exec.mockReset();
  mockDb.exec.mockResolvedValue(undefined);
  mockDb.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM mastra_threads')) {
      return {
        rows: [
          {
            createdAt: new Date('2026-04-22T10:00:00Z'),
            id: 'thread-existing',
            resourceId: '/tmp/test-workspace',
            title: 'Existing thread',
            updatedAt: new Date('2026-04-22T10:00:00Z'),
          },
        ],
      };
    }
    return { rows: [] };
  });
  Object.defineProperty(window, 'agentHost', {
    configurable: true,
    value: { connect: async () => undefined },
  });
  window.localStorage.removeItem('brainstrike.assistant.include-file-report.v1');
  window.localStorage.removeItem('brainstrike-assistant-threads-v1');
});

afterEach(() => {
  __resetConfiguredAssistantProvidersForTests();
  __resetAssistantPreferencesStoreForTests();
  __resetAssistantForegroundActivityForTests();
  __resetWorkspaceCollectionSyncStatusStoreForTests();
  Reflect.deleteProperty(window, 'tools');
  providedMcpTools = null;
  Reflect.deleteProperty(window, 'agentHost');
  Reflect.deleteProperty(window, 'desktopLifecycle');
  Reflect.deleteProperty(window, '__brainstrikeAssistantRuntimeTestHooks__');
});

export const renderAssistantPanel = async (
  providers: string[],
  afterRender?: () => Promise<void>
) => {
  const renderResult = render(
    <McpToolsCapabilityProvider capability={providedMcpTools}>
      <AssistantProviderSourceProvider
        source={{ kind: 'authoritative', providers: providers as SupportedProvider[] }}
      >
        <AssistantUiPanelWrapper providerKeySources={[{ provider: 'openai', source: 'stored' }]} />
      </AssistantProviderSourceProvider>
    </McpToolsCapabilityProvider>
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
    <McpToolsCapabilityProvider capability={providedMcpTools}>
      <AssistantProviderSourceProvider
        source={{ kind: 'authoritative', providers: providers as SupportedProvider[] }}
      >
        <AssistantUiPanelWrapper
          memoryResourceId="/tmp/test-workspace"
          memoryThreadId={threadId}
          providerKeySources={[{ provider: 'openai', source: 'stored' }]}
        />
      </AssistantProviderSourceProvider>
    </McpToolsCapabilityProvider>
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

/** The host's MCP tools behind the composer menu, as separately observable calls. */
interface McpApi {
  disableTools?: (toolIds: string[]) => Promise<void>;
  enableTools?: (toolIds: string[]) => Promise<void>;
  listTools: () => Promise<Record<string, McpToolDescriptor[]>>;
  onToolsUpdated?: (callback: (tools: Record<string, McpToolDescriptor[]>) => void) => () => void;
}

/** What the next rendered panel's provider supplies; reset after each test. */
let providedMcpTools: McpToolsCapability | null = null;

/** Supplies the MCP tools `setMcpApi` installed to a directly rendered panel. */
/** The wrapper with the host-provided MCP tools and an authoritative provider list. */
export function TestWrapperTree({ providers }: { readonly providers: readonly ProviderId[] }) {
  return (
    <TestMcpToolsProvider>
      <AssistantProviderSourceProvider
        source={{ kind: 'authoritative', providers: [...providers] }}
      >
        <AssistantUiPanelWrapper />
      </AssistantProviderSourceProvider>
    </TestMcpToolsProvider>
  );
}

export function TestMcpToolsProvider({ children }: { readonly children: ReactNode }) {
  return (
    <McpToolsCapabilityProvider capability={providedMcpTools}>
      {children}
    </McpToolsCapabilityProvider>
  );
}

export const setMcpApi = (overrides: Partial<McpApi> = {}) => {
  const api: McpApi = {
    disableTools: vi.fn().mockResolvedValue(undefined),
    enableTools: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({}),
    onToolsUpdated: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  providedMcpTools = {
    list: () => api.listTools(),
    setEnabled: async (toolIds, enabled) => {
      await (enabled ? api.enableTools : api.disableTools)?.([...toolIds]);
    },
    subscribe: (listener) => api.onToolsUpdated?.(listener) ?? (() => undefined),
  };
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

export {
  changesetRefreshMock,
  fileExplorerMocks,
  hasDesktopLlmHostMock,
  mockDb,
  preparedRequestDataLog,
  testEnabledModels,
  useChangesetMock,
};
