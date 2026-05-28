import {
  DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
  DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
} from '@brainstrike/assistant-contract/memory-settings';
import { PGlite } from '@electric-sql/pglite';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
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
    const observationalMemoryModel = {
      modelId: 'claude-haiku-4-5',
      provider: 'anthropic',
    } as unknown as MastraModelConfig;

    await createPgliteMastraMemory({
      database: db,
      observationalMemoryModel,
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
          model: observationalMemoryModel,
          scope: 'resource',
          retrieval: { scope: 'resource' },
          observation: { messageTokens: 18_000 },
          reflection: { observationTokens: 36_000 },
        },
        semanticRecall: false,
      },
    });
  });

  it('sources Mastra history and working-memory defaults from runtime assistant defaults', async () => {
    await createPgliteMastraMemory({ database: db });

    expect(memoryConstructorCalls).toHaveLength(1);
    expect(memoryConstructorCalls[0]).toMatchObject({
      options: {
        lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES,
        workingMemory: DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY,
      },
    });
  });

  it('throws instead of silently disabling semantic recall when no embedder is configured', async () => {
    await expect(
      createPgliteMastraMemory({
        database: db,
        memorySettings: {
          observationalMemory: {
            enabled: true,
            modelTarget: 'openai/gpt-5.2-chat-latest',
            scope: 'thread',
            messageTokens: 30_000,
            observationTokens: 40_000,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            enabled: true,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            messageRange: 2,
            scope: 'resource',
            topK: 5,
          },
        },
      })
    ).rejects.toThrow('PGlite Mastra semantic recall requires an explicit embedder.');
  });

  it('passes explicit semantic recall settings and embedder into Mastra Memory', async () => {
    const embedder = {
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    } as unknown as MastraEmbeddingModel<string>;

    await createPgliteMastraMemory({
      database: db,
      embedder,
      memorySettings: {
        observationalMemory: {
          enabled: false,
          modelTarget: 'openai/gpt-5.2-chat-latest',
          scope: 'thread',
          messageTokens: 30_000,
          observationTokens: 40_000,
          retrievalMode: 'off',
        },
        semanticRecall: {
          enabled: true,
          embeddingModelTarget: 'openai/text-embedding-3-small',
          messageRange: 3,
          scope: 'resource',
          topK: 7,
        },
      },
    });

    expect(memoryConstructorCalls).toHaveLength(1);
    expect(memoryConstructorCalls[0]).toMatchObject({
      embedder,
      options: {
        semanticRecall: {
          messageRange: 3,
          scope: 'resource',
          topK: 7,
        },
      },
    });
  });

  it('passes runtime memory options into Mastra Memory without overriding hosted memory settings', async () => {
    const observationalMemoryModel = {
      modelId: 'gpt-5.2-chat-latest',
      provider: 'openai',
    } as unknown as MastraModelConfig;

    await createPgliteMastraMemory({
      database: db,
      memoryOptions: {
        lastMessages: false,
        workingMemory: { enabled: false },
      },
      memorySettings: {
        observationalMemory: {
          enabled: true,
          modelTarget: 'openai/gpt-5.2-chat-latest',
          scope: 'thread',
          messageTokens: 12_000,
          observationTokens: 24_000,
          retrievalMode: 'off',
        },
        semanticRecall: {
          enabled: false,
          embeddingModelTarget: 'openai/text-embedding-3-small',
          messageRange: 2,
          scope: 'resource',
          topK: 5,
        },
      },
      observationalMemoryModel,
    });

    expect(memoryConstructorCalls).toHaveLength(1);
    expect(memoryConstructorCalls[0]).toMatchObject({
      options: {
        lastMessages: false,
        workingMemory: { enabled: false },
        semanticRecall: false,
        observationalMemory: {
          model: observationalMemoryModel,
          scope: 'thread',
          observation: { messageTokens: 12_000 },
          reflection: { observationTokens: 24_000 },
        },
      },
    });
  });
});
