import type { RuntimeAssistantMemorySettings } from '@brainstrike/agent';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { handleAssistantRequest } from '../../assistant-server';
import {
  getDesktopMastraMemoryForTests,
  resetDesktopMastraMemoryCacheForTests,
} from '../../assistant-server/mastra-memory';
import {
  mockDesktopDatabase,
  mockPgliteMastraMemory,
  mockPgliteMastraStorage,
  mockSecretsService,
} from './_assistant-server-mocks';
import { createRunRequest } from './_harness';

// Mock dependencies: per-file vi.mock call sites (hoisting is
// per-importing-module) over the shared factory bodies + fixtures in
// _assistant-server-mocks.ts (BST-1029). The DYNAMIC import is LOAD-BEARING
// (both alternatives verified red): a bare imported factory reference is
// evaluated at hoist time, and even a lazy arrow over the STATIC import
// breaks because '../../assistant-server' initializes first in import order
// and triggers these factories before the mocks module's bindings exist. The
// dynamic import shares the same per-file module instance as the static
// fixture imports below.
// vi.hoisted lifts the accessor above the hoisted vi.mock calls; the dynamic
// import inside stays lazy.
const mocks = vi.hoisted(() => () => import('./_assistant-server-mocks'));
vi.mock('../../assistant-server/http', async () => (await mocks()).makeAssistantServerHttpMock());
vi.mock('../../agent-client-loader', async () => (await mocks()).makeAgentClientLoaderMock());
vi.mock('../../secrets', async () => (await mocks()).makeSecretsMock());
vi.mock('@brainstrike/agent/hosted-web', async () => (await mocks()).makeHostedWebAgentMock());
vi.mock('@brainstrike/agent', async () => (await mocks()).makeAgentMock());
vi.mock('@brainstrike/agent/pglite-mastra-memory', async () =>
  (await mocks()).makePgliteMastraMemoryMock()
);
vi.mock('../../assistant-server/assistant-tools', async () =>
  (await mocks()).makeAssistantToolsMock()
);
vi.mock(
  '../../../../../packages/host-capabilities/src/native-tools/workspace-text-file-reader',
  async () => (await mocks()).makeWorkspaceTextFileReaderMock()
);
vi.mock('../../db-main', async () => (await mocks()).makeDbMainMock());

const runRequest = createRunRequest(handleAssistantRequest);

beforeEach(() => {
  mockDesktopDatabase.exec.mockReset();
  mockDesktopDatabase.query.mockReset();
  // Default: workspace-roots enrichment (runs first on every assistant
  // stream init) sees no roots and cleanly falls back. Tests that exercise
  // other queries override this.
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
  resetDesktopMastraMemoryCacheForTests();
  mockSecretsService.getCredential
    .mockReset()
    .mockResolvedValue({ key: 'test-api-key', type: 'api_key' });
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
    } satisfies RuntimeAssistantMemorySettings;
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
    } satisfies RuntimeAssistantMemorySettings;
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
    } satisfies RuntimeAssistantMemorySettings;

    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const firstMemory = await getDesktopMastraMemoryForTests(memorySettingsA);
    const secondMemory = await getDesktopMastraMemoryForTests(memorySettingsB);

    expect(firstMemory).toBe(secondMemory);
    expect(createPgliteMastraMemory).toHaveBeenCalledTimes(1);
  });

  it('constructs fresh memory when factory reset replaces the database owner', async () => {
    const { getDatabase } = await import('../../db-main');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const databaseGetter = vi.mocked(getDatabase);
    const originalDatabase = await databaseGetter();
    await getDesktopMastraMemoryForTests(undefined);
    const replacementDatabase = { ...originalDatabase };
    databaseGetter.mockResolvedValue(replacementDatabase);
    try {
      await getDesktopMastraMemoryForTests(undefined);
      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(2);
      expect(createPgliteMastraMemory).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: replacementDatabase })
      );
      await getDesktopMastraMemoryForTests(undefined);
      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(2);
    } finally {
      databaseGetter.mockResolvedValue(originalDatabase);
    }
  });

  it('keeps an old pending credential resolution out of the replacement database cache', async () => {
    const { getDatabase } = await import('../../db-main');
    const { createPgliteMastraMemory } = await import('@brainstrike/agent/pglite-mastra-memory');
    const originalDatabase = await getDatabase();
    const replacementDatabase = { ...originalDatabase };
    const credential = Promise.withResolvers<{ key: string; type: 'api_key' }>();
    mockSecretsService.getCredential.mockImplementationOnce(() => credential.promise);
    const settings = {
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
    } satisfies RuntimeAssistantMemorySettings;
    const oldRequest = getDesktopMastraMemoryForTests(settings);
    await vi.waitFor(() => expect(mockSecretsService.getCredential).toHaveBeenCalledTimes(1));
    vi.mocked(getDatabase).mockResolvedValue(replacementDatabase);
    try {
      const replacement = await getDesktopMastraMemoryForTests(settings);
      expect(createPgliteMastraMemory).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: replacementDatabase })
      );
      credential.resolve({ key: 'test-api-key', type: 'api_key' });
      const old = await oldRequest;
      expect(old).not.toBe(replacement);
      expect(createPgliteMastraMemory).toHaveBeenLastCalledWith(
        expect.objectContaining({ database: originalDatabase })
      );
      await expect(getDesktopMastraMemoryForTests(settings)).resolves.toBe(replacement);
      expect(createPgliteMastraMemory).toHaveBeenCalledTimes(2);
    } finally {
      credential.resolve({ key: 'test-api-key', type: 'api_key' });
      await oldRequest;
      vi.mocked(getDatabase).mockResolvedValue(originalDatabase);
    }
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
