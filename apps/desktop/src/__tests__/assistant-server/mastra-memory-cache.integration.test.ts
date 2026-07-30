import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import {
  getDesktopMastraMemoryForTests,
  resetDesktopMastraMemoryCacheForTests,
} from '../../assistant-server/mastra-memory';
import { createRunRequest } from './_harness';

// Mock dependencies
vi.mock('../../assistant-server/http', async () => {
  const actual = await vi.importActual<typeof import('../../assistant-server/http')>(
    '../../assistant-server/http'
  );
  return {
    ...actual,
    streamResponse: vi.fn(),
    writeHeaders: vi.fn(),
  };
});

vi.mock('../../mcp-loader', () => ({
  loadMcpConfig: vi.fn(() => Promise.resolve({ config: undefined })),
}));

vi.mock('../../agent-client-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-client-loader')>();
  return {
    ...actual,
    getAgentProviderEnvKeys: vi.fn(() => []),
  };
});

const mockSecretsService = {
  deleteKey: vi.fn(),
  getKey: vi.fn((_provider: string) => Promise.resolve('test-api-key')),
  listProviders: vi.fn(() => Promise.resolve(['openai'])),
  saveKey: vi.fn(),
};

vi.mock('../../secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../secrets')>();
  return {
    ...actual,
    getSecretsService: vi.fn(() => mockSecretsService),
  };
});

vi.mock('@brainstrike/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/agent')>();
  const convertAssistantUiMessages = vi.fn((messages) => messages);
  return {
    ...actual,
    assistantDataStreamSessions: {
      create: vi.fn(() => ({
        createResponse: vi.fn(() => ({
          body: null,
          headers: new Headers(),
          status: 200,
        })),
        getTerminalOutcome: vi.fn(() => ({ error: null, status: 'completed' })),
        id: 'session-test',
        messageId: 'assistant-message-test',
        whenClosed: vi.fn(() => Promise.resolve()),
      })),
    },
    convertAssistantUiMessages,
    convertAssistantUiMessagesWithFinalInput: vi.fn(
      (
        messages: Parameters<typeof actual.convertAssistantUiMessagesWithFinalInput>[0]
      ): ReturnType<typeof actual.convertAssistantUiMessagesWithFinalInput> => {
        const finalRawMessage = messages.at(-1);
        const { finalInputMessage } = actual.convertAssistantUiMessagesWithFinalInput(
          finalRawMessage ? [finalRawMessage] : []
        );
        return {
          finalInputMessage,
          messages: convertAssistantUiMessages(messages),
        };
      }
    ),
    createEmbeddingProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
      type: 'embedding-model',
    })),
    createLanguageModelProvider: vi.fn((provider: string, apiKey: string, model: string) => ({
      apiKey,
      model,
      provider,
    })),
    isSupportedProvider: (provider: string) =>
      ['openai', 'anthropic', 'google', 'openrouter', 'local', 'ollama'].includes(provider),
    listSuspendedMastraRuns: vi.fn(() => Promise.resolve({ approvals: [] })),
    resolveDataStreamSession: vi.fn(() => {}),
    sanitizeAssistantRunEventMetadata: vi.fn((metadata) => metadata),
    streamMastraToolApprovalAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'approval resumed' };
      },
    })),
    streamMastraToolResumeAction: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', value: 'suspend resumed' };
      },
    })),
    toAiSdkStyleStream: vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { content: 'test', type: 'text' };
      },
    })),
  };
});

const mockPgliteMastraMemory = { id: 'desktop-memory' };
const mockPgliteMastraStorage = { id: 'desktop-storage' };
const mockDesktopDatabase = {
  exec: vi.fn(),
  query: vi.fn(),
};

vi.mock('@brainstrike/agent/pglite-mastra-memory', () => ({
  createPgliteMastraMemory: vi.fn(() =>
    Promise.resolve({
      memory: mockPgliteMastraMemory,
      storage: mockPgliteMastraStorage,
      store: {},
      vector: {},
      workflows: {},
    })
  ),
}));

vi.mock('../../assistant-server/assistant-tools', () => ({
  buildDesktopAssistantTools: vi.fn(() => ({})),
}));

// The "@file" context injector resolves referenced files through this reader.
// None of these tests send a file directive, so it is never invoked — but it
// must exist on the mock so the server's named import resolves.
vi.mock('../../assistant-server/workspace-text-file-reader', () => ({
  readWorkspaceTextFile: vi.fn(async () => ({ content: '', path: '', size: 0 })),
}));

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(() => Promise.resolve(mockDesktopDatabase)),
}));

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getKey.mockReset().mockResolvedValue('test-api-key');
  mockSecretsService.listProviders.mockReset().mockResolvedValue(['openai']);
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
});

afterEach(() => {
  vi.clearAllMocks();
  resetDesktopMastraMemoryCacheForTests();
}, 15_000);
describe('desktop Mastra memory cache', () => {
  it('retries desktop Mastra memory initialization after a transient failure', async () => {
    const { toAiSdkStyleStream, convertAssistantUiMessages } = await import('@brainstrike/agent');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const { streamResponse } = await import('../../assistant-server/http');
    const memoryContext = {
      memorySettings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 12_000,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 24_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
        },
      },
      resourceId: 'workspace-retry',
      threadId: 'thread-retry',
    };

    (convertAssistantUiMessages as Mock).mockReturnValue([
      { parts: [{ text: 'Hello', type: 'text' }], role: 'user' },
    ]);
    (createPgliteMastraMemory as Mock)
      .mockRejectedValueOnce(new Error('temporary memory init failure'))
      .mockResolvedValueOnce({
        memory: mockPgliteMastraMemory,
        storage: mockPgliteMastraStorage,
        store: {},
        vector: {},
        workflows: {},
      });
    (toAiSdkStyleStream as Mock).mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { content: 'Response', type: 'text' };
      },
    });
    (streamResponse as Mock).mockImplementation(async (res: unknown) => {
      const response = res as { end?: () => void };
      response.end?.();
    });

    const failedResponse = await runRequest({
      body: JSON.stringify({
        data: { memory: memoryContext, provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });
    const retriedResponse = await runRequest({
      body: JSON.stringify({
        data: { memory: memoryContext, provider: 'openai' },
        messages: [{ parts: [{ text: 'Hello', type: 'text' }], role: 'user' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      url: '/',
    });

    expect(failedResponse.status).toBe(502);
    expect(retriedResponse.status).toBe(200);
    expect(createPgliteMastraMemory).toHaveBeenCalledTimes(2);
  });

  it('keeps separate in-flight Mastra memory initializations keyed by settings', async () => {
    mockDesktopDatabase.exec.mockResolvedValue(undefined);
    const memorySettingsA = {
      observationalMemory: {
        enabled: true,
        messageTokens: 10_000,
        modelTarget: 'openai/gpt-5.2',
        observationTokens: 20_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: false,
        messageRange: 1,
        scope: 'resource',
        topK: 3,
      },
    };
    const memorySettingsB = {
      ...memorySettingsA,
      observationalMemory: {
        ...memorySettingsA.observationalMemory,
        messageTokens: 12_000,
      },
    };

    const firstRequest = getDesktopMastraMemoryForTests(memorySettingsA);
    const secondRequest = getDesktopMastraMemoryForTests(memorySettingsB);
    const thirdRequest = getDesktopMastraMemoryForTests(memorySettingsA);
    const [firstMemory, secondMemory, thirdMemory] = await Promise.all([
      firstRequest,
      secondRequest,
      thirdRequest,
    ]);

    expect(firstMemory).toBe(thirdMemory);
    expect(firstMemory).not.toBe(secondMemory);
  });

  it('reuses desktop Mastra memory for semantically identical settings with different key order', async () => {
    mockDesktopDatabase.exec.mockResolvedValue(undefined);
    const memorySettingsA = {
      observationalMemory: {
        enabled: true,
        messageTokens: 10_000,
        modelTarget: 'openai/gpt-5.2',
        observationTokens: 20_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: false,
        messageRange: 1,
        scope: 'resource',
        topK: 3,
      },
    };
    const memorySettingsB = {
      observationalMemory: {
        enabled: true,
        messageTokens: 10_000,
        modelTarget: 'openai/gpt-5.2',
        observationTokens: 20_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: false,
        messageRange: 1,
        scope: 'resource',
        topK: 3,
      },
    };

    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const firstMemory = await getDesktopMastraMemoryForTests(memorySettingsA);
    const secondMemory = await getDesktopMastraMemoryForTests(memorySettingsB);

    expect(firstMemory).toBe(secondMemory);
    expect(createPgliteMastraMemory).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest desktop Mastra memory cache entries', async () => {
    mockDesktopDatabase.exec.mockResolvedValue(undefined);
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');

    for (let index = 0; index < 17; index += 1) {
      await getDesktopMastraMemoryForTests({
        observationalMemory: {
          enabled: true,
          messageTokens: 10_000 + index,
          modelTarget: 'openai/gpt-5.2',
          observationTokens: 20_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 1,
          scope: 'resource',
          topK: 3,
        },
      });
    }

    await getDesktopMastraMemoryForTests({
      observationalMemory: {
        enabled: true,
        messageTokens: 10_000,
        modelTarget: 'openai/gpt-5.2',
        observationTokens: 20_000,
        retrievalMode: 'off',
        scope: 'thread',
      },
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: false,
        messageRange: 1,
        scope: 'resource',
        topK: 3,
      },
    });

    // 17 distinct keys against DESKTOP_MEMORY_CACHE_LIMIT = 16 evicts the
    // first; re-requesting it reconstructs -> 17 + 1 = 18.
    expect(createPgliteMastraMemory).toHaveBeenCalledTimes(18);
  });
});
