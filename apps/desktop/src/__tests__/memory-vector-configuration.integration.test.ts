// @vitest-environment node
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createPgliteMastraMemory } from '@brainstrike/agent/pglite-mastra-memory';
import {
  committedMemoryTranscript,
  HostLogRowSchema,
  type ProductionHostRunConfiguration,
  readHostRow,
  StateStoreHostMemory,
  StateStoreMemoryStorage,
} from '@brainstrike/agent-host';
import {
  createStateStoreIndexer,
  openIndexer,
  type StateMessageQuery,
  type StateMessageVectorPort,
  type VectorProfile,
} from '@brainstrike/indexer';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createDesktopHostMemoryConfiguration } from '../agent-host-platform/memory-model-configuration';
import type { DesktopHostMemoryVectorCapabilities } from '../agent-host-platform/memory-vector-configuration';
import {
  type PlatformSelection,
  PlatformSelectionSchema,
} from '../agent-host-platform/platform-wire';
import captured from './fixtures/committed-rich-host-runs.json';

const require = createRequire(import.meta.url);
const hostDirectory = dirname(require.resolve('@brainstrike/agent-host'));
type PublicMemory = Awaited<ReturnType<typeof createPgliteMastraMemory>>['memory'];
// Desktop borrows public Memory through agent-host's declared dependency closure.
// Resolve the installed public export with Node; no package alias or manifest edit.
const publicMemoryModule: unknown = await import(
  pathToFileURL(createRequire(join(hostDirectory, 'index.js')).resolve('@mastra/memory')).href
);
const Memory = z
  .object({
    Memory: z.custom<
      new (
        options: ProductionHostRunConfiguration['memory']['native']
      ) => PublicMemory
    >((input) => typeof input === 'function'),
  })
  .parse(publicMemoryModule).Memory;
const profile: VectorProfile = {
  dimensions: 8,
  distance: 'cosine',
  dtype: 'fp32',
  modelId: 'deterministic-configuration-proof',
  provider: 'local',
  revision: 'c'.repeat(40),
  tokenCap: 512,
};
const recordings = z.array(HostLogRowSchema).parse(captured);
const started = recordings.find((row) => row.event.type === 'run.started');
if (started?.event.type !== 'run.started') {
  throw new Error('Recorded committed Core run is required');
}
const threadId = started.threadId;
const runId = started.event.runId;
const resourceId = 'configuration-proof-resource';
const requests = () => Promise.withResolvers<void>();

function selection(scope: 'thread' | 'resource' = 'thread'): PlatformSelection {
  return PlatformSelectionSchema.parse({
    configuration: { model: 'gpt-4.1-mini', provider: 'openai' },
    contextWindow: 128_000,
    durableConfiguration: {},
    inputTokenLimit: 64_000,
    maxSteps: 1,
    memory: {
      options: {
        lastMessages: 1,
        workingMemory: { enabled: false, scope: 'thread', template: '# Configuration proof' },
      },
      settings: {
        observationalMemory: {
          enabled: false,
          messageTokens: 30_000,
          modelTarget: 'openai/gpt-4.1-mini',
          observationTokens: 40_000,
          retrievalMode: 'off',
          scope: 'thread',
        },
        semanticRecall: {
          embeddingModelTarget: `local/${profile.modelId}`,
          enabled: true,
          messageRange: 0,
          scope,
          topK: 1,
        },
      },
    },
    resourceId,
    tools: {},
    toolTimeoutMs: 10_000,
  });
}

function embedding(text: string): number[] {
  return Array.from({ length: profile.dimensions }, (_, index) =>
    index === (text.includes('Capture rich') ? 0 : 1) ? 1 : 0
  );
}

async function fixture(scope: 'thread' | 'resource' = 'thread') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-memory-configuration-')));
  const controller = new AbortController();
  const queries: StateMessageQuery[] = [];
  const embeddings: { signal: AbortSignal | undefined; values: readonly string[] }[] = [];
  let hold:
    | { admitted: ReturnType<typeof requests>; release: ReturnType<typeof requests> }
    | undefined;
  const indexer = await openIndexer(
    {
      dbPath: join(root, 'index.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [root],
      stateProjection: {
        mode: 'dev',
        module: pathToFileURL(require.resolve('@brainstrike/agent-host/state-projection')).href,
      },
      stateResources: [{ profile, resourceId, rootId: root }],
      stateRoot: root,
    },
    { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
  );
  const store = await StateStore.open(root, {
    indexer: createStateStoreIndexer(indexer),
    memoryCalculatorModule: join(hostDirectory, 'adapters/memory-storage-calculator.js'),
  });
  await store.append(recordings.map((row) => ({ event: row.event, threadId: row.threadId })));
  const port: StateMessageVectorPort = {
    prepareStateMessageVectors: (input) => indexer.prepareStateMessageVectors(input),
    purgeStateMessageVectors: (input) => indexer.purgeStateMessageVectors(input),
    queryStateMessageVectors: (input) => {
      queries.push(structuredClone(input));
      return indexer.queryStateMessageVectors(input);
    },
    upsertStateMessageVectors: (input) => indexer.upsertStateMessageVectors(input),
  };
  const caps: DesktopHostMemoryVectorCapabilities = {
    embedder: {
      doEmbed: async ({ values, abortSignal }) => {
        embeddings.push({ signal: abortSignal, values: [...values] });
        if (hold) {
          hold.admitted.resolve();
          await hold.release.promise; // Deliberately ignores abort until raw inference retires.
        }
        return {
          embeddings: values.map(embedding),
          usage: { tokens: values.length },
          warnings: [],
        };
      },
      maxEmbeddingsPerCall: 1,
      modelId: profile.modelId,
      provider: 'deterministic-test-only',
      specificationVersion: 'v3',
      supportsParallelCalls: false,
    },
    port,
    profile,
    scope: { resourceId, rootId: root, threadId },
    signal: controller.signal,
  };
  const admitted = selection(scope);
  const configuration = await createDesktopHostMemoryConfiguration(
    admitted,
    async () => undefined,
    caps
  );
  const owner = await StateStoreHostMemory.open(
    { runId, signal: controller.signal, threadId },
    { ...configuration, store }
  );
  return {
    admitted,
    caps,
    async close() {
      hold?.release.resolve();
      try {
        await owner.close();
      } finally {
        try {
          await store.close();
        } finally {
          try {
            await indexer.destroy();
            for (const suffix of ['', '-wal', '-shm']) {
              expect(existsSync(join(root, `index.sqlite${suffix}`))).toBe(false);
            }
          } finally {
            await rm(root, { force: true, recursive: true });
            expect(existsSync(root)).toBe(false);
          }
        }
      }
    },
    configuration,
    controller,
    embeddings,
    holdEmbedding() {
      hold = { admitted: requests(), release: requests() };
      return hold;
    },
    indexer,
    owner,
    queries,
    root,
    store,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Live inference is forbidden in deterministic configuration proofs');
    })
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test.each(['thread', 'resource'] as const)(
  'configured public %s recall consumes the borrowed actual indexer with canonical identities',
  async (scope) => {
    const f = await fixture(scope);
    try {
      const before = await f.store.readAll();
      expect(f.configuration.native.vector).toBe(f.configuration.vectorBridge);
      expect(f.configuration.native.embedder).toBe(f.caps.embedder);
      expect(f.configuration.native.options?.semanticRecall).toEqual({
        messageRange: 0,
        scope,
        topK: 1,
      });
      await f.owner.commitHostStep();
      const rows = await Promise.all(before.map((row) => readHostRow(f.store, row)));
      const transcript = committedMemoryTranscript(rows, resourceId);
      const recalled = await f.owner.memory.recall({
        resourceId,
        threadConfig: { lastMessages: false },
        vectorSearchString: 'The committed effect completed.',
      });
      expect(recalled.messages).toHaveLength(1);
      expect(recalled.messages[0]?.id).toBe(
        transcript.find((message) => message.id === JSON.stringify([threadId, 54]))?.id
      );
      const query = f.queries.at(-1);
      expect(query).toMatchObject({ limit: 1, profile, scope: f.caps.scope });
      expect(query?.threadIds).toEqual(scope === 'thread' ? [threadId] : undefined);
      if (!query) {
        throw new Error('Public recall did not reach the actual indexer');
      }
      const hits = await f.indexer.queryStateMessageVectors(query);
      expect(hits[0]).toMatchObject({
        messageId: recalled.messages[0]?.id,
        score: 1,
        seq: 54,
        threadId,
      });
      expect(f.embeddings.length).toBeGreaterThan(0);
      expect(await f.store.readAll()).toEqual(before);
      expect(await f.store.check()).toEqual({ gaps: 0, integrity: 'ok' });
    } finally {
      await f.close();
    }
  }
);

test('mismatched or absent borrowed capabilities refuse without altering admitted options', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.admitted);
    const auth = vi.fn(async () => undefined);
    for (const vectors of [
      undefined,
      { ...f.caps, scope: { ...f.caps.scope, resourceId: 'foreign-resource' } },
      { ...f.caps, scope: { ...f.caps.scope, threadId: '' } },
      { ...f.caps, profile: { ...profile, modelId: 'substituted-model' } },
      { ...f.caps, profile: { ...profile, dimensions: 0 } },
      { ...f.caps, profile: { ...profile, distance: 'l2' as const } },
    ]) {
      await expect(
        createDesktopHostMemoryConfiguration(f.admitted, auth, vectors)
      ).rejects.toBeInstanceOf(Error);
    }
    const missingTarget = structuredClone(f.admitted);
    missingTarget.memory.settings.semanticRecall.embeddingModelTarget = null;
    await expect(createDesktopHostMemoryConfiguration(missingTarget, auth, f.caps)).rejects.toThrow(
      /embedding model target/
    );
    expect(f.admitted).toEqual(original);
    expect(auth).not.toHaveBeenCalled();
    expect(f.embeddings).toHaveLength(0);
    expect(f.queries).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('disabled recall and existing observer messages/off options preserve provider model and thresholds', async () => {
  const admitted = selection();
  admitted.memory.settings.semanticRecall.enabled = false;
  const disabled = await createDesktopHostMemoryConfiguration(admitted, async () => undefined);
  expect(disabled.native.options).toEqual({
    ...admitted.memory.options,
    observationalMemory: false,
    semanticRecall: false,
  });
  expect(disabled.vectorBridge).toBeUndefined();
  for (const retrievalMode of ['off', 'messages'] as const) {
    admitted.memory.settings.observationalMemory = {
      ...admitted.memory.settings.observationalMemory,
      enabled: true,
      retrievalMode,
      scope: 'resource',
    };
    const auth = vi.fn(async () => ({
      apiKey: 'deterministic-no-call-fixture',
      kind: 'api_key' as const,
    }));
    const configuration = await createDesktopHostMemoryConfiguration(admitted, auth);
    expect(auth).toHaveBeenCalledExactlyOnceWith('openai');
    expect(configuration.native.options?.observationalMemory).toMatchObject({
      model: { modelId: 'gpt-4.1-mini' },
      observation: { messageTokens: 30_000 },
      reflection: { observationTokens: 40_000 },
      scope: 'resource',
    });
    const observation = configuration.native.options?.observationalMemory;
    if (!observation || typeof observation !== 'object') {
      throw new Error('Concrete observer is required');
    }
    expect(observation.retrieval).toEqual(
      retrievalMode === 'messages' ? { scope: 'resource' } : undefined
    );
  }
  await expect(
    createDesktopHostMemoryConfiguration(admitted, async () => undefined)
  ).rejects.toThrow(/API credential/);
});

test('configured run signal reaches concrete inference and close joins its physical retirement', async () => {
  const f = await fixture();
  try {
    const hold = f.holdEmbedding();
    const commit = f.owner.commitHostStep();
    await hold.admitted.promise;
    const reason = new Error('Configuration proof run stopped');
    f.controller.abort(reason);
    expect(f.embeddings.at(-1)?.signal?.aborted).toBe(true);
    let closed = false;
    const close = f.owner.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    hold.release.resolve();
    await Promise.all([commit, close]);
    expect(closed).toBe(true);
    expect(
      await f.indexer.queryStateMessageVectors({
        limit: 1,
        profile,
        scope: f.caps.scope,
        vector: embedding('completed'),
      })
    ).toEqual([]);
    await expect(
      createDesktopHostMemoryConfiguration(f.admitted, async () => undefined, f.caps)
    ).rejects.toBe(reason);
  } finally {
    await f.close();
  }
});

test('vector OM refuses explicitly and the public observation probe preserves distinct durable group authority', async () => {
  const f = await fixture();
  let domain: StateStoreMemoryStorage | undefined;
  let memory: PublicMemory | undefined;
  try {
    const observationSelection = structuredClone(f.admitted);
    observationSelection.memory.settings.observationalMemory.enabled = true;
    observationSelection.memory.settings.observationalMemory.retrievalMode = 'vector';
    const original = structuredClone(observationSelection);
    await expect(
      createDesktopHostMemoryConfiguration(observationSelection, async () => undefined, f.caps)
    ).rejects.toThrow(/observation-group authority/);
    expect(observationSelection).toEqual(original);
    await f.owner.commitHostStep();
    domain = new StateStoreMemoryStorage(
      resourceId,
      f.store,
      {
        read: async () =>
          committedMemoryTranscript(
            await Promise.all((await f.store.readAll()).map((row) => readHostRow(f.store, row))),
            resourceId
          ),
      },
      threadId
    );
    const record = await domain.initializeObservationalMemory({
      config: {},
      resourceId,
      scope: 'thread',
      threadId,
    });
    const groupId = 'deterministic-observation-anchor';
    const range = 'recorded-first-message:recorded-last-message';
    const text = 'Synthetic observation from the deterministic configuration probe.';
    const observedAt = new Date('2026-10-07T00:00:00.000Z');
    await domain.updateActiveObservations({
      id: record.id,
      lastObservedAt: observedAt,
      observations: `<observation-group id="${groupId}" range="${range}">\n${text}\n</observation-group>`,
      tokenCount: 10,
    });
    const durable = (
      await f.store.memory({ operation: 'read', ownerThreadId: threadId, resourceId })
    ).entities.find((entity) => entity.kind === 'observation' && entity.id === record.id);
    expect(durable?.payload['id']).toBe(record.id);
    expect(durable?.payload['activeObservations']).toContain(`id="${groupId}"`);
    const probeConfiguration = await createDesktopHostMemoryConfiguration(
      f.admitted,
      async () => undefined,
      f.caps
    );
    const bridge = probeConfiguration.vectorBridge;
    if (!bridge) {
      throw new Error('Borrowed existing vector bridge is required');
    }
    memory = new Memory({
      embedder: probeConfiguration.native.embedder,
      options: { semanticRecall: false },
      vector: bridge,
    });
    const upsert = vi.spyOn(bridge, 'upsert');
    const transcript = committedMemoryTranscript(
      await Promise.all((await f.store.readAll()).map((row) => readHostRow(f.store, row))),
      resourceId
    );
    const canonical = transcript.find((message) => message.role === 'user');
    if (!canonical) {
      throw new Error('Recorded canonical user source is required');
    }
    const operation = () =>
      memory!.indexObservation({ groupId, observedAt, range, resourceId, text, threadId });
    await expect(
      bridge.withPreparedMessages([{ messageId: canonical.id, seq: started.seq }], operation)
    ).rejects.toThrow(/aliases/);
    const input = upsert.mock.calls[0]?.[0];
    expect(input?.metadata?.[0]?.['group_id']).toBe(groupId);
    expect(input?.metadata?.[0]?.['message_id']).toBeUndefined();
    expect(input?.ids).toHaveLength(1);
    const output = await memory.searchMessages({ query: 'completed', resourceId, topK: 1 });
    expect(output.results).toEqual([]);
    const query = f.queries.at(-1);
    if (!query) {
      throw new Error('Observation query did not consume the borrowed port');
    }
    const canonicalHits = await f.indexer.queryStateMessageVectors(query);
    expect(canonicalHits).toHaveLength(1);
    console.info(
      'Vector OM causal receipt:',
      JSON.stringify({
        canonicalHitIds: canonicalHits.map((hit) => hit.messageId),
        durableEntityId: durable?.id,
        groupId,
        input,
        kind: durable?.kind,
        output,
        recordId: record.id,
        resourceId: record.resourceId,
        scope: record.scope,
        threadId: record.threadId,
      })
    );
  } finally {
    try {
      await memory?.settled();
      await domain?.close();
    } finally {
      await f.close();
    }
  }
});
