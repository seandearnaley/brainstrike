import { CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createEnginePglite } from '@brainstrike/db/pglite-factory';
import { Agent } from '@mastra/core/agent';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { expect, it, vi } from 'vitest';
import { createPgliteMastraMemory } from '../pglite-mastra-memory';
import { scriptedAgentModel, textParts } from '../test-fixtures/scripted-agent-model';

it('indexes and recalls across repeated concurrent agent turns with one shared WASM hasher', async () => {
  const database = await createEnginePglite();
  const embedder: MastraEmbeddingModel<string> = {
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [1, 0, 0]),
      usage: { tokens: values.length },
    }),
    maxEmbeddingsPerCall: undefined,
    modelId: 'semantic-lifecycle',
    provider: 'test',
    specificationVersion: 'v2',
    supportsParallelCalls: true,
  };
  const { memory } = await createPgliteMastraMemory({
    database: {
      exec: (query) => database.exec(query),
      query: (query, values) => database.query(query, values ? [...values] : undefined),
      transaction: (operation) =>
        database.transaction((tx) =>
          operation({
            exec: (query) => tx.exec(query),
            query: (query, values) => tx.query(query, values ? [...values] : undefined),
          })
        ),
    },
    embedder,
    memoryOptions: { generateTitle: false, lastMessages: 2, workingMemory: { enabled: false } },
    memorySettings: {
      ...CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
      semanticRecall: {
        embeddingModelTarget: 'openai/text-embedding-3-small',
        enabled: true,
        messageRange: 0,
        scope: 'thread',
        topK: 100,
      },
    },
  });
  const instantiate = vi.spyOn(WebAssembly, 'instantiate');
  const before = process.memoryUsage();
  const agents = Array.from({ length: 4 }, (_, index) => {
    const model = scriptedAgentModel(() => textParts(`SHARED_RECALL_MARKER_${index}`));
    return {
      agent: new Agent({
        id: `recall-${index}`,
        instructions: 'Answer',
        memory,
        model: model.model,
        name: `Recall ${index}`,
      }),
      model,
    };
  });
  try {
    for (let round = 0; round < 8; round += 1) {
      await Promise.all(
        agents.map(async ({ agent }, index) => {
          const result = await agent.stream(`Recall the shared marker, request ${round}`, {
            memory: { resource: 'shared-owner', thread: `recall-thread-${index}` },
          });
          await result.consumeStream();
          expect(result.status).toBe('success');
        })
      );
    }
    await memory.settled();
    const rows = await database.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM mastra_messages'
    );
    expect(rows.rows[0]?.count).toBe(64);
    // Recall returns the oldest query, outside the configured two-message
    // history window, through the real vector/store/processor composition.
    expect(JSON.stringify(agents[0]?.model.prompts.at(-1))).toContain('request 0');
    const after = process.memoryUsage();
    console.info('Semantic recall lifecycle measurement', {
      arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
      instantiateCalls: instantiate.mock.calls.length,
      rssDelta: after.rss - before.rss,
      turns: 32,
    });
    expect(instantiate.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    instantiate.mockRestore();
    await memory.settled();
    await database.close();
  }
}, 30_000);
