import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock Electron module for tests that transitively import window-state.ts
vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/mock/app'),
    getName: vi.fn(() => 'Brainstrike'),
    getPath: vi.fn(() => '/mock/path'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: vi.fn(),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString('utf-8')),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn(),
  },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })),
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
    },
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
}));

// Mock `electron-store` globally. Its module body destructures
// `const {app, ipcMain, shell} = electron` at import time, so when `electron`
// is aliased to the test stub (see vitest.config.mts) any per-test
// `vi.mock('electron', …)` that returns only a partial surface would otherwise
// crash electron-store at import. Tests inject fake stores via DI, so an inert
// constructor is sufficient here; files that exercise electron-store directly
// still override this with their own per-file `vi.mock('electron-store', …)`.
vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  return { default: MockElectronStore };
});

// Mock Electron APIs
const mockElectronAPI = {
  fileSystem: {
    addRoot: vi.fn().mockResolvedValue({
      displayName: 'mock-directory',
      handle: {
        kind: 'directory',
        name: 'mock-directory',
        path: '/mock/path',
        platform: 'electron',
      },
      kind: 'path',
      permissionState: 'granted',
      persisted: true,
      rootId: 'mock-root-id',
    }),
    exists: vi.fn().mockResolvedValue(true),
    getWatcherTelemetry: vi.fn().mockResolvedValue({
      activeWatchers: 0,
      cleanups: 0,
      failures: 0,
      healthPushes: 0,
      retries: 0,
    }),
    onWatchEvent: vi.fn(() => () => {}),
    onWatchHealth: vi.fn((_callback: (event: unknown) => void) => () => {}),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue('mock file content'),
    readFileByPath: vi.fn().mockResolvedValue('mock file content by path'),
    requestDirectoryAccess: vi.fn().mockResolvedValue({
      kind: 'directory',
      name: 'mock-directory',
      path: '/mock/path',
      platform: 'electron',
    }),
    restoreLastFolder: vi.fn().mockResolvedValue(null),
    restoreRoots: vi.fn().mockResolvedValue([]),
    retryWatch: vi.fn().mockResolvedValue({ retried: true }),
    saveLastFolder: vi.fn().mockResolvedValue(undefined),
    unwatchDirectory: vi.fn().mockResolvedValue(undefined),
    watchDirectory: vi.fn().mockResolvedValue({ watchId: 'mock-watch-id' }),
  },
  getUserDataPath: vi.fn().mockResolvedValue('/mock/user/data'),
  storage: {
    clear: vi.fn().mockResolvedValue(undefined),
    getAllKeys: vi.fn().mockResolvedValue([]),
    getItem: vi.fn().mockResolvedValue(null),
    removeItem: vi.fn().mockResolvedValue(undefined),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
};

// Mock window.electronAPI
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true,
});

// Mock window.secrets
const mockSecrets = {
  clearAll: vi.fn().mockResolvedValue({ success: true } as const),
  deleteKey: vi.fn().mockResolvedValue(true),
  getKey: vi.fn().mockResolvedValue(null as string | null),
  list: vi.fn().mockResolvedValue([] as string[]),
  listStored: vi.fn().mockResolvedValue([] as string[]),
  saveKey: vi.fn().mockResolvedValue(true as const),
};
Object.defineProperty(window, 'secrets', {
  value: mockSecrets,
  writable: true,
});

// Mock window.agent
const mockAgent = {
  chat: vi.fn().mockResolvedValue([
    { name: 'plan', status: 'start', type: 'tool-event' },
    { type: 'text-delta', value: 'Hello' },
    { type: 'text-delta', value: ' world' },
    { name: 'plan', status: 'success', type: 'tool-event' },
  ]),
};
Object.defineProperty(window, 'agent', {
  value: mockAgent,
  writable: true,
});

Object.defineProperty(window, 'llmHost', {
  value: {
    ensureStarted: vi.fn().mockResolvedValue({ active: false, lastError: null, state: 'running' }),
    generate: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({ active: false, lastError: null, state: 'running' }),
    onProgress: vi.fn(() => () => {}),
    onRequest: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    reportProgress: vi.fn(),
    reportResponse: vi.fn(),
    reportStatus: vi.fn(),
    reset: vi.fn().mockResolvedValue({ active: false, lastError: null, state: 'running' }),
    stop: vi.fn().mockResolvedValue({ active: false, lastError: null, state: 'stopped' }),
    warmup: vi.fn().mockResolvedValue(undefined),
  },
  writable: true,
});

process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '1';

const mockProviderDefinitions = [
  {
    capabilities: { embeddings: true, llm: true, streaming: true },
    displayName: 'OpenAI',
    envKeys: ['BRAINSTRIKE_OPENAI_API_KEY'],
    id: 'openai',
    models: [
      { default: true, id: 'gpt-5.2', supportsStreaming: true, type: 'llm' as const },
      {
        default: true,
        defaultDimension: 1536,
        id: 'text-embedding-3-small',
        supportsStandardDimension: true,
        type: 'embedding' as const,
      },
    ],
    runtime: 'hosted',
  },
  {
    capabilities: { embeddings: false, llm: true, streaming: true },
    displayName: 'Anthropic',
    envKeys: ['ANTHROPIC_API_KEY'],
    id: 'anthropic',
    models: [{ default: true, id: 'claude-sonnet-4-6', type: 'llm' as const }],
    runtime: 'hosted',
  },
  {
    capabilities: { embeddings: true, llm: true, streaming: true },
    displayName: 'Google AI Studio',
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    id: 'google',
    models: [
      { default: true, id: 'gemini-3.5-flash', type: 'llm' as const },
      {
        default: true,
        defaultDimension: 3072,
        id: 'gemini-embedding-001',
        supportsStandardDimension: true,
        type: 'embedding' as const,
      },
    ],
    runtime: 'hosted',
  },
] as const;

type MockProviderId = (typeof mockProviderDefinitions)[number]['id'];

const mockProviderDefaults = Object.fromEntries(
  mockProviderDefinitions.map((definition) => [
    definition.id,
    definition.models.find((model) => model.type === 'llm')?.id ?? definition.models[0]?.id,
  ])
) as Record<MockProviderId, string>;

const mockProviderModels = Object.fromEntries(
  mockProviderDefinitions.map((definition) => [
    definition.id,
    definition.models.filter((model) => model.type === 'llm').map((model) => model.id),
  ])
) as Record<MockProviderId, string[]>;

// Only include models with default: true in the enabled defaults
const mockProviderDefaultEnabledModels = Object.fromEntries(
  mockProviderDefinitions.map((definition) => [
    definition.id,
    definition.models
      .filter((model) => model.type === 'llm' && model.default)
      .map((model) => model.id),
  ])
) as Record<MockProviderId, string[]>;

const mockEmbeddingModels = Object.fromEntries(
  mockProviderDefinitions.map((definition) => [
    definition.id,
    definition.models.filter((model) => model.type === 'embedding'),
  ])
) as Record<MockProviderId, (typeof mockProviderDefinitions)[number]['models']>;

const mockProviderDisplayNames = Object.fromEntries(
  mockProviderDefinitions.map((definition) => [definition.id, definition.displayName])
) as Record<MockProviderId, string>;

const providerIdSet = new Set<MockProviderId>(
  mockProviderDefinitions.map((definition) => definition.id)
);

function ensureDefinition(provider: string): (typeof mockProviderDefinitions)[number] {
  const definition = mockProviderDefinitions.find((item) => item.id === provider);
  if (!definition) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return definition;
}

function cloneDefinition(definition: (typeof mockProviderDefinitions)[number]) {
  return {
    ...definition,
    models: definition.models.map((model) => ({ ...model })),
  } as (typeof mockProviderDefinitions)[number];
}

const mockMcpToolRegistry = {
  clear: vi.fn(),
  disableServerTools: vi.fn(),
  disableTools: vi.fn(),
  enableServerTools: vi.fn(),
  enableTools: vi.fn(),
  getAllTools: vi.fn(() => ({})),
  getEnabledTools: vi.fn((tools: Record<string, unknown>) => tools),
  getStats: vi.fn(() => ({ disabled: 0, enabled: 0, servers: 0, total: 0 })),
  register: vi.fn(),
  reset: vi.fn(),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    createMastraAgentRuntime: vi.fn(async () => ({
      dispose: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
    })),
    isSupportedProvider: (provider: string) =>
      mockProviderDefinitions.some((entry) => entry.id === provider),
    loadToolPreferences: vi.fn().mockResolvedValue({}),
    mcpToolRegistry: mockMcpToolRegistry,
    streamMastraAgent: vi.fn(async function* () {
      yield { type: 'finish', usage: { completionTokens: 1, promptTokens: 1 } };
    }),
  };
});

vi.mock('@brainstrike/agent/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent/client')>();
  return {
    ...actual,
    compareByLoadPriority: actual.compareByLoadPriority,
    generateExampleInput: actual.generateExampleInput,
    getCategoryInfo: actual.getCategoryInfo,
    getNativeToolDefaults: actual.getNativeToolDefaults,
    getProviderDefaultModel: (provider: string) => mockProviderDefaults[provider as MockProviderId],
    getProviderDefinition: (provider: string) => ensureDefinition(provider),
    getProviderDisplayName: (provider: string) =>
      mockProviderDisplayNames[provider as MockProviderId] ?? provider,
    getProviderModelDefinitions: (provider: string) => ensureDefinition(provider).models,
    getProviderModels: (provider: string) => mockProviderModels[provider as MockProviderId] ?? [],
    getTierInfo: actual.getTierInfo,
    getToolSchemaDisplay: actual.getToolSchemaDisplay,
    isNativeTool: actual.isNativeTool,
    isSupportedProvider: (provider: string) => providerIdSet.has(provider as MockProviderId),
    listEmbeddingModels: (provider: string) =>
      mockEmbeddingModels[provider as MockProviderId] ?? [],
    // Provider-related mocks
    listProviders: () => mockProviderDefinitions.map((definition) => cloneDefinition(definition)),
    // Tool-related exports (pass through from actual module)
    NATIVE_TOOL_DEFAULTS: actual.NATIVE_TOOL_DEFAULTS,
    // Schema display exports
    NATIVE_TOOL_SCHEMAS: actual.NATIVE_TOOL_SCHEMAS,
    PROVIDER_DEFAULT_ENABLED_MODELS: mockProviderDefaultEnabledModels,
    PROVIDER_DEFAULT_MODELS: mockProviderDefaults,
    PROVIDER_DISPLAY_NAMES: mockProviderDisplayNames,
    PROVIDER_MODELS: mockProviderModels,
    providerEnvKeys: (provider: string) => ensureDefinition(provider).envKeys ?? [],
    supportsStandardEmbeddingDimension: (provider: string) =>
      (mockEmbeddingModels[provider as MockProviderId] ?? []).some(
        (model) => model.supportsStandardDimension
      ),
    TOOL_CATEGORIES: actual.TOOL_CATEGORIES,
    TOOL_DESCRIPTIONS: actual.TOOL_DESCRIPTIONS,
    TOOL_LOADING_TIERS: actual.TOOL_LOADING_TIERS,
  };
});

vi.mock('@brainstrike/agent/local-llm', () => ({
  LocalLlmBackend: class MockLocalLlmBackend {
    static getBestDevice(): 'webgpu' {
      return 'webgpu';
    }

    static async hasDownloadedModel(): Promise<boolean> {
      return false;
    }

    static async downloadModel(): Promise<void> {}

    async dispose(): Promise<void> {}

    async generate(): Promise<Record<string, unknown>> {
      return {
        finishReason: 'stop',
        promptText: '',
        rawText: '',
        text: '',
        toolCalls: [],
        usage: {
          completionTokens: 0,
          promptTokens: 0,
          totalTokens: 0,
        },
      };
    }

    async initialize(): Promise<void> {}
  },
}));

// Mock react-router-dom for components that use it
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    BrowserRouter: ({ children }: { children: React.ReactNode }) => children,
    Route: ({ children }: { children: React.ReactNode }) => children,
    Routes: ({ children }: { children: React.ReactNode }) => children,
    useLocation: () => ({ pathname: '/' }),
    useNavigate: () => vi.fn(),
  };
});

// Export mocks for use in tests
export { mockElectronAPI };
