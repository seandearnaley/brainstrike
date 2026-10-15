import { DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES } from '@brainstrike/assistant-contract/memory-settings';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPristineBareTestDb } from '../../__tests__/helpers/migrated-agent-test-db';
import { createPgliteMastraMemory, type PgliteMastraMemoryOptions } from '../memory-factory';
import type { PgliteDatabase } from '../types';

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
  let database: PgliteDatabase;

  beforeEach(async () => {
    db = await createPristineBareTestDb();
    database = db as unknown as PgliteDatabase;
    memoryConstructorCalls.length = 0;
  });

  afterEach(async () => {
    await db.close();
  });

  it('throws instead of resolving observational memory from a serialized model target', async () => {
    await expect(
      createPgliteMastraMemory({
        database,
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
      })
    ).rejects.toThrow('PGlite Mastra observational memory requires an explicit model.');
  });

  it('uses Mastra title generation independently of observational memory', async () => {
    const observationalMemoryModel = {
      modelId: 'gpt-5.4-mini',
      provider: 'openai',
    } as unknown as NonNullable<PgliteMastraMemoryOptions['observationalMemoryModel']>;

    await createPgliteMastraMemory({
      database,
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
      observationalMemoryModel,
    });

    const options = (
      memoryConstructorCalls[0] as {
        options: { generateTitle: boolean; observationalMemory: unknown };
      }
    ).options;
    expect(options.generateTitle).toBe(true);
    expect(options.observationalMemory).toMatchObject({
      observation: { messageTokens: 12_000 },
    });
    expect(options.observationalMemory).not.toMatchObject({
      observation: { bufferOnIdle: true },
    });
    expect(options.observationalMemory).not.toMatchObject({
      observation: { threadTitle: true },
    });
  });

  it('generates titles even when observational memory is disabled', async () => {
    await createPgliteMastraMemory({
      database,
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
      options: { generateTitle: true, observationalMemory: false },
    });
  });

  it('respects an explicit title-generation override', async () => {
    await createPgliteMastraMemory({
      database,
      memoryOptions: { generateTitle: false },
    });

    expect(memoryConstructorCalls[0]).toMatchObject({
      options: { generateTitle: false },
    });
  });

  it('throws instead of silently disabling semantic recall when no embedder is configured', async () => {
    await expect(
      createPgliteMastraMemory({
        database,
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
    const result = await createPgliteMastraMemory({ database });
    const workflowStore = await result.storage.getStore('workflows');

    expect(workflowStore).toBe(result.workflows);
    expect(result.workflows.supportsConcurrentUpdates()).toBe(true);
  });

  it('passes runtime memory options and concrete observational model into Mastra Memory', async () => {
    const observationalMemoryModel = {
      modelId: 'gpt-5.4-mini',
      provider: 'openai',
    } as unknown as NonNullable<PgliteMastraMemoryOptions['observationalMemoryModel']>;

    await createPgliteMastraMemory({
      database,
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
    await createPgliteMastraMemory({ database });

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
        database,
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
