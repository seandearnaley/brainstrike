import {
  InMemoryStore,
  Memory,
  TokenCounter,
  wrapInObservationGroup,
} from '@brainstrike/test-utils/fixtures/observation-memory';

/** Capture real native storage shape using public OM operations, without inference.
 * @param {'thread'|'resource'} scope @param {string} resourceId @param {string} threadId
 */
export async function captureStorage(scope, resourceId, threadId) {
  const store = new InMemoryStore({ id: 'observation-storage-fixture' });
  await store.init();
  const memory = await store.getStore('memory');
  if (!memory) {
    throw new Error('Public memory store missing');
  }
  const initial = await memory.initializeObservationalMemory({
    config: {},
    resourceId,
    scope,
    threadId: scope === 'thread' ? threadId : null,
  });
  return {
    activate: () =>
      memory.swapBufferedToActive({
        activationRatio: 1,
        currentPendingTokens: 3000,
        id: initial.id,
        messageTokensThreshold: 1000,
      }),
    /** @param {string} body @param {Date} date */
    active: async (body, date) => {
      await memory.updateActiveObservations({
        id: initial.id,
        lastObservedAt: date,
        observations: body,
        tokenCount: 1,
      });
    },
    /** @param {string} body @param {Date} date */
    buffered: async (body, date) => {
      await memory.updateBufferedObservations({
        chunk: {
          cycleId: 'fixture-cycle',
          lastObservedAt: date,
          messageIds: ['recorded-first-message', 'recorded-last-message'],
          messageTokens: 2000,
          observations: body,
          tokenCount: 1,
        },
        id: initial.id,
      });
    },
    close: () => store.close(),
    /** @returns {Promise<import('@brainstrike/state-store').MemoryEntity[]>} */
    records: async () =>
      (
        await memory.getObservationalMemoryHistory(scope === 'thread' ? threadId : null, resourceId)
      ).map((record) => ({
        id: record.id,
        kind: 'observation',
        payload: JSON.parse(JSON.stringify(record)),
        threadId: record.threadId,
      })),
    /** @param {string} body */
    reflect: async (body) => {
      const current = await memory.getObservationalMemory(
        scope === 'thread' ? threadId : null,
        resourceId
      );
      if (!current) {
        throw new Error('Native record missing');
      }
      return memory.createReflectionGeneration({
        currentRecord: current,
        reflection: body,
        tokenCount: 1,
      });
    },
  };
}

/** @param {import('@brainstrike/indexer').StateObservationSource} source @param {string} resourceId
 * @param {{admitted:()=>void,release:Promise<void>} | undefined} [hold] */
export async function captureIndex(source, resourceId, hold) {
  const captured = [];
  const vector = {
    createIndex: async () => {},
    id: 'native-capture',
    upsert: async (input) => {
      captured.push(input);
      return input.ids;
    },
  };
  const memory = new Memory({
    embedder: {
      doEmbed: async ({ values }) => {
        hold?.admitted();
        await hold?.release;
        return {
          embeddings: values.map(() => [0.125, -0.25, 0.375, -0.5, 0.625, -0.75, 0.875, -1.031_25]),
          warnings: [],
        };
      },
      maxEmbeddingsPerCall: undefined,
      modelId: 'deterministic-storage-proof',
      provider: 'deterministic-test-only',
      specificationVersion: 'v3',
      supportsParallelCalls: true,
    },
    options: { semanticRecall: false },
    vector,
  });
  await memory.indexObservation({
    ...source,
    observedAt: source.observedAt === undefined ? undefined : new Date(source.observedAt),
    resourceId,
  });
  if (captured.length !== 1) {
    throw new Error('Expected one actual native upsert');
  }
  return captured[0];
}
/** @param {string} text @param {string} groupId @param {string} threadId @param {'thread'|'resource'} scope */
export function groupText(text, groupId, threadId, scope) {
  const group = wrapInObservationGroup(
    text,
    'recorded-first-message:recorded-last-message',
    groupId
  );
  return scope === 'thread' ? group : `<thread id="${threadId}">\n${group}\n</thread>`;
}

/** Mastra OM's own observation token count (`TokenCounter.countObservations`). @param {string} text */
export function observationTokens(text) {
  return new TokenCounter().countObservations(text);
}
