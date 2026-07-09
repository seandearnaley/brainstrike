import { DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES } from '@brainstrike/assistant-contract/memory-settings';
import { PGlite } from '@electric-sql/pglite';
import type { MastraModelConfig } from '@mastra/core/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteMastraMemory } from '../memory-factory';

const memoryConstructorCalls: unknown[] = [];

vi.mock('@mastra/memory', () => ({
  Memory: vi.fn(
    class {
      readonly config: unknown;

      constructor(config: unknown) {
        this.config = config;
        memoryConstructorCalls.push(config);
      }
    }
  ),
}));

describe('createPgliteMastraMemory', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite();
    memoryConstructorCalls.length = 0;
  });

  afterEach(async () => {
    await db.close();
  });

  it('passes explicit observational memory settings into Mastra Memory', async () => {
    await createPgliteMastraMemory({
      database: db,
      memorySettings: {
        observationalMemory: {
          enabled: true,
          messageTokens: 18_000,
          modelTarget: 'anthropic/claude-haiku-4-5',
          observationTokens: 36_000,
          retrievalMode: 'messages',
          scope: 'resource',
        },
        semanticRecall: {
          embeddingModelTarget: 'openai/text-embedding-3-small',
          enabled: false,
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
    });

    expect(memoryConstructorCalls).toHaveLength(1);
    expect(memoryConstructorCalls[0]).toMatchObject({
      options: {
        observationalMemory: {
          model: 'anthropic/claude-haiku-4-5',
          observation: { messageTokens: 18_000, threadTitle: true },
          reflection: { observationTokens: 36_000 },
          retrieval: { scope: 'resource' },
          scope: 'resource',
        },
        semanticRecall: false,
      },
    });
  });

  it('opts into observer thread-title extraction whenever observational memory is enabled', async () => {
    await createPgliteMastraMemory({
      database: db,
      memorySettings: {
        observationalMemory: {
          enabled: true,
          messageTokens: 12_000,
          modelTarget: 'openai/gpt-5.4-mini',
          observationTokens: 24_000,
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
      },
    });

    const options = (memoryConstructorCalls[0] as { options: { observationalMemory: unknown } })
      .options;
    expect(options.observationalMemory).toMatchObject({
      observation: { threadTitle: true },
    });
  });

  it('does not construct an observational memory option (or its thread-title flag) when disabled', async () => {
    await createPgliteMastraMemory({
      database: db,
      memorySettings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 12_000,
          modelTarget: 'openai/gpt-5.4-mini',
          observationTokens: 24_000,
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
      },
    });

    expect(memoryConstructorCalls[0]).toMatchObject({
      options: { observationalMemory: false },
    });
  });

  it('throws instead of silently disabling semantic recall when no embedder is configured', async () => {
    await expect(
      createPgliteMastraMemory({
        database: db,
        memorySettings: {
          observationalMemory: {
            enabled: true,
            messageTokens: 30_000,
            modelTarget: 'openai/gpt-5.4-mini',
            observationTokens: 40_000,
            retrievalMode: 'vector',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: 'openai/text-embedding-3-small',
            enabled: true,
            messageRange: 2,
            scope: 'resource',
            topK: 5,
          },
        },
      })
    ).rejects.toThrow('PGlite Mastra semantic recall requires an explicit embedder.');
  });

  it('registers PGlite workflow snapshots on the Mastra composite store', async () => {
    const result = await createPgliteMastraMemory({ database: db });
    const workflowStore = await result.storage.getStore('workflows');

    expect(workflowStore).toBe(result.workflows);
    expect(result.workflows.supportsConcurrentUpdates()).toBe(true);
  });

  it('passes runtime memory options and concrete observational model into Mastra Memory', async () => {
    const observationalMemoryModel = {
      modelId: 'gpt-5.4-mini',
      provider: 'openai',
    } as unknown as MastraModelConfig;

    await createPgliteMastraMemory({
      database: db,
      memoryOptions: {
        lastMessages: 8,
        workingMemory: { enabled: false },
      },
      memorySettings: {
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
      },
      observationalMemoryModel,
    });

    expect(memoryConstructorCalls[0]).toMatchObject({
      options: {
        lastMessages: 8,
        observationalMemory: {
          model: observationalMemoryModel,
        },
        workingMemory: { enabled: false },
      },
    });
  });

  it('defaults lastMessages to DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES when no memoryOptions supplied', async () => {
    await createPgliteMastraMemory({ database: db });

    expect(memoryConstructorCalls).toHaveLength(1);
    expect(memoryConstructorCalls[0]).toMatchObject({
      options: {
        lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
      },
    });
  });

  it('throws instead of enabling vector observational retrieval without an embedder', async () => {
    let thrown: unknown;

    try {
      await createPgliteMastraMemory({
        database: db,
        memorySettings: {
          observationalMemory: {
            enabled: true,
            messageTokens: 30_000,
            modelTarget: 'openai/gpt-5.4-mini',
            observationTokens: 40_000,
            retrievalMode: 'vector',
            scope: 'thread',
          },
          semanticRecall: {
            embeddingModelTarget: 'openai/text-embedding-3-small',
            enabled: false,
            messageRange: 2,
            scope: 'resource',
            topK: 5,
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'PGlite Mastra observational vector retrieval requires an explicit embedder.'
    );
  });
});
