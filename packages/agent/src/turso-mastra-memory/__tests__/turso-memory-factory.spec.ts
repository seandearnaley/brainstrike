import { DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES } from '@brainstrike/assistant-contract/memory-settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTursoMastraMemory } from '../memory-factory';
import type { TursoMastraSqlClient } from '../types';

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

function createFakeClient(): TursoMastraSqlClient {
  return {
    exec: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
    transaction: vi.fn(async (fn) =>
      fn({
        exec: vi.fn(async () => undefined),
        query: vi.fn(async () => ({ rows: [] })),
      })
    ),
  };
}

describe('createTursoMastraMemory', () => {
  beforeEach(() => {
    memoryConstructorCalls.length = 0;
  });

  it('registers Turso workflow snapshots on the Mastra composite store', async () => {
    const result = await createTursoMastraMemory({
      database: createFakeClient(),
      memorySettings: {
        observationalMemory: {
          enabled: false,
          modelTarget: 'openai/gpt-5.4-mini',
          scope: 'thread',
          messageTokens: 30_000,
          observationTokens: 40_000,
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
    });
    const workflowStore = await result.storage.getStore('workflows');

    expect(workflowStore).toBe(result.workflows);
    expect(result.workflows.supportsConcurrentUpdates()).toBe(true);
    expect(memoryConstructorCalls[0]).toMatchObject({
      options: { lastMessages: DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES },
    });
    expect(memoryConstructorCalls[0]).not.toHaveProperty('vector');
  });

  it('fails closed when semantic recall requests vector memory', async () => {
    await expect(
      createTursoMastraMemory({
        database: createFakeClient(),
        embedder: 'openai:text-embedding-3-small',
        memorySettings: {
          observationalMemory: {
            enabled: false,
            modelTarget: 'openai/gpt-5.4-mini',
            scope: 'thread',
            messageTokens: 30_000,
            observationTokens: 40_000,
            retrievalMode: 'off',
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
    ).rejects.toThrow('Turso Mastra semantic recall requires Turso vector memory support.');
  });

  it('fails closed when observational memory requests vector retrieval', async () => {
    await expect(
      createTursoMastraMemory({
        database: createFakeClient(),
        embedder: 'openai:text-embedding-3-small',
        memorySettings: {
          observationalMemory: {
            enabled: true,
            modelTarget: 'openai/gpt-5.4-mini',
            scope: 'thread',
            messageTokens: 30_000,
            observationTokens: 40_000,
            retrievalMode: 'vector',
          },
          semanticRecall: {
            enabled: false,
            embeddingModelTarget: 'openai/text-embedding-3-small',
            messageRange: 2,
            scope: 'resource',
            topK: 5,
          },
        },
      })
    ).rejects.toThrow(
      'Turso Mastra observational vector retrieval requires Turso vector memory support.'
    );
  });
});
