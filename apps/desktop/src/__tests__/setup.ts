import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock Electron module for tests that transitively import window-state.ts
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Brainstrike'),
    getVersion: vi.fn(() => '0.0.0-test'),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
  },
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString('utf-8')),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn(),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
    },
  },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
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
  storage: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    getAllKeys: vi.fn().mockResolvedValue([]),
  },
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
    requestDirectoryAccess: vi.fn().mockResolvedValue({
      path: '/mock/path',
      name: 'mock-directory',
      kind: 'directory',
      platform: 'electron',
    }),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue('mock file content'),
    readFileByPath: vi.fn().mockResolvedValue('mock file content by path'),
    exists: vi.fn().mockResolvedValue(true),
    restoreLastFolder: vi.fn().mockResolvedValue(null),
    restoreRoots: vi.fn().mockResolvedValue([]),
    saveLastFolder: vi.fn().mockResolvedValue(undefined),
  },
  getUserDataPath: vi.fn().mockResolvedValue('/mock/user/data'),
};

// Mock window.electronAPI
Object.defineProperty(window, 'electronAPI', {
  value: mockElectronAPI,
  writable: true,
});

// Mock window.secrets
const mockSecrets = {
  saveKey: vi.fn().mockResolvedValue(true as const),
  getKey: vi.fn().mockResolvedValue(null as string | null),
  deleteKey: vi.fn().mockResolvedValue(true),
  list: vi.fn().mockResolvedValue([] as string[]),
  listStored: vi.fn().mockResolvedValue([] as string[]),
  clearAll: vi.fn().mockResolvedValue({ success: true } as const),
};
Object.defineProperty(window, 'secrets', {
  value: mockSecrets,
  writable: true,
});

// Mock window.agent
const mockAgent = {
  chat: vi.fn().mockResolvedValue([
    { type: 'tool-event', name: 'plan', status: 'start' },
    { type: 'text-delta', value: 'Hello' },
    { type: 'text-delta', value: ' world' },
    { type: 'tool-event', name: 'plan', status: 'success' },
  ]),
};
Object.defineProperty(window, 'agent', {
  value: mockAgent,
  writable: true,
});

Object.defineProperty(window, 'llmHost', {
  value: {
    ensureStarted: vi.fn().mockResolvedValue({ state: 'running', active: false, lastError: null }),
    stop: vi.fn().mockResolvedValue({ state: 'stopped', active: false, lastError: null }),
    reset: vi.fn().mockResolvedValue({ state: 'running', active: false, lastError: null }),
    getStatus: vi.fn().mockResolvedValue({ state: 'running', active: false, lastError: null }),
    warmup: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue(null),
    reportStatus: vi.fn(),
    reportProgress: vi.fn(),
    reportResponse: vi.fn(),
    onStatus: vi.fn(() => () => {}),
    onProgress: vi.fn(() => () => {}),
    onRequest: vi.fn(() => () => {}),
  },
  writable: true,
});

process.env['BRAINSTRIKE_AGENT_TEST_MODE'] = '1';

const mockProviderDefinitions = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    runtime: 'hosted',
    capabilities: { llm: true, embeddings: true, streaming: true },
    envKeys: ['BRAINSTRIKE_OPENAI_API_KEY'],
    models: [
      { id: 'gpt-5.2', type: 'llm' as const, default: true, supportsStreaming: true },
      {
        id: 'text-embedding-3-small',
        type: 'embedding' as const,
        default: true,
        defaultDimension: 1536,
        supportsStandardDimension: true,
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    runtime: 'hosted',
    capabilities: { llm: true, embeddings: false, streaming: true },
    envKeys: ['ANTHROPIC_API_KEY'],
    models: [{ id: 'claude-sonnet-4-6', type: 'llm' as const, default: true }],
  },
  {
    id: 'google',
    displayName: 'Google AI Studio',
    runtime: 'hosted',
    capabilities: { llm: true, embeddings: true, streaming: true },
    envKeys: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    models: [
      { id: 'gemini-3.5-flash', type: 'llm' as const, default: true },
      {
        id: 'gemini-embedding-001',
        type: 'embedding' as const,
        default: true,
        defaultDimension: 3072,
        supportsStandardDimension: true,
      },
    ],
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
  getAllTools: vi.fn(() => ({})),
  getStats: vi.fn(() => ({ total: 0, enabled: 0, disabled: 0, servers: 0 })),
  enableTools: vi.fn(),
  disableTools: vi.fn(),
  enableServerTools: vi.fn(),
  disableServerTools: vi.fn(),
  reset: vi.fn(),
  register: vi.fn(),
  clear: vi.fn(),
  getEnabledTools: vi.fn((tools: Record<string, unknown>) => tools),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  return {
    ...actual,
    streamMastraAgent: vi.fn(async function* () {
      yield { type: 'finish', usage: { promptTokens: 1, completionTokens: 1 } };
    }),
    loadToolPreferences: vi.fn().mockResolvedValue({}),
    mcpToolRegistry: mockMcpToolRegistry,
    createMastraAgentRuntime: vi.fn(async () => ({
      run: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    })),
    isSupportedProvider: (provider: string) =>
      mockProviderDefinitions.some((entry) => entry.id === provider),
  };
});

vi.mock('@brainstrike/agent/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent/client')>();
  return {
    ...actual,
    // Provider-related mocks
    listProviders: () => mockProviderDefinitions.map((definition) => cloneDefinition(definition)),
    providerEnvKeys: (provider: string) => ensureDefinition(provider).envKeys ?? [],
    PROVIDER_DEFAULT_MODELS: mockProviderDefaults,
    PROVIDER_DEFAULT_ENABLED_MODELS: mockProviderDefaultEnabledModels,
    PROVIDER_MODELS: mockProviderModels,
    PROVIDER_DISPLAY_NAMES: mockProviderDisplayNames,
    getProviderDefaultModel: (provider: string) => mockProviderDefaults[provider as MockProviderId],
    getProviderModels: (provider: string) => mockProviderModels[provider as MockProviderId] ?? [],
    getProviderDefinition: (provider: string) => ensureDefinition(provider),
    getProviderDisplayName: (provider: string) =>
      mockProviderDisplayNames[provider as MockProviderId] ?? provider,
    getProviderModelDefinitions: (provider: string) => ensureDefinition(provider).models,
    listEmbeddingModels: (provider: string) =>
      mockEmbeddingModels[provider as MockProviderId] ?? [],
    supportsStandardEmbeddingDimension: (provider: string) =>
      (mockEmbeddingModels[provider as MockProviderId] ?? []).some(
        (model) => model.supportsStandardDimension
      ),
    isSupportedProvider: (provider: string) => providerIdSet.has(provider as MockProviderId),
    // Tool-related exports (pass through from actual module)
    NATIVE_TOOL_DEFAULTS: actual.NATIVE_TOOL_DEFAULTS,
    TOOL_DESCRIPTIONS: actual.TOOL_DESCRIPTIONS,
    TOOL_CATEGORIES: actual.TOOL_CATEGORIES,
    TOOL_LOADING_TIERS: actual.TOOL_LOADING_TIERS,
    getNativeToolDefaults: actual.getNativeToolDefaults,
    isNativeTool: actual.isNativeTool,
    getCategoryInfo: actual.getCategoryInfo,
    getTierInfo: actual.getTierInfo,
    compareByLoadPriority: actual.compareByLoadPriority,
    // Schema display exports
    NATIVE_TOOL_SCHEMAS: actual.NATIVE_TOOL_SCHEMAS,
    getToolSchemaDisplay: actual.getToolSchemaDisplay,
    generateExampleInput: actual.generateExampleInput,
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
        text: '',
        rawText: '',
        promptText: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: {
          promptTokens: 0,
          completionTokens: 0,
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
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/' }),
    BrowserRouter: ({ children }: { children: React.ReactNode }) => children,
    Routes: ({ children }: { children: React.ReactNode }) => children,
    Route: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Export mocks for use in tests
export { mockElectronAPI };
