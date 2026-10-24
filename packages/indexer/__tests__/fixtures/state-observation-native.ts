import type { StateObservationSource } from '@brainstrike/indexer';
import type { MemoryEntity } from '@brainstrike/state-store';
import {
  InMemoryStore,
  Memory,
  TokenCounter,
  wrapInObservationGroup,
} from '@brainstrike/test-utils/fixtures/observation-memory';

type MemoryScope = 'thread' | 'resource';
/** The fields of a native observational memory record this fixture reads. */
interface NativeObservationRecord {
  readonly id: string;
  readonly threadId: string | null;
}
/** The vector upsert Mastra's Memory sends its vector store. */
interface NativeUpsert {
  readonly ids: string[];
}
interface IndexHold {
  admitted(): void;
  readonly release: Promise<void>;
}

/** Capture real native storage shape using public OM operations, without inference. */
export async function captureStorage(scope: MemoryScope, resourceId: string, threadId: string) {
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
    active: async (body: string, date: Date): Promise<void> => {
      await memory.updateActiveObservations({
        id: initial.id,
        lastObservedAt: date,
        observations: body,
        tokenCount: 1,
      });
    },
    buffered: async (body: string, date: Date): Promise<void> => {
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
    records: async (): Promise<MemoryEntity[]> =>
      (
        await memory.getObservationalMemoryHistory(scope === 'thread' ? threadId : null, resourceId)
      ).map((record: NativeObservationRecord) => ({
        id: record.id,
        kind: 'observation',
        payload: JSON.parse(JSON.stringify(record)),
        threadId: record.threadId,
      })),
    reflect: async (body: string) => {
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

export async function captureIndex(
  source: StateObservationSource,
  resourceId: string,
  hold?: IndexHold
): Promise<NativeUpsert> {
  const captured: NativeUpsert[] = [];
  const vector = {
    createIndex: async () => {},
    id: 'native-capture',
    upsert: async (input: NativeUpsert) => {
      captured.push(input);
      return input.ids;
    },
  };
  const memory = new Memory({
    embedder: {
      doEmbed: async ({ values }: { readonly values: readonly unknown[] }) => {
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
  const [upsert] = captured;
  if (captured.length !== 1 || upsert === undefined) {
    throw new Error('Expected one actual native upsert');
  }
  return upsert;
}
export function groupText(
  text: string,
  groupId: string,
  threadId: string,
  scope: MemoryScope
): string {
  const group = wrapInObservationGroup(
    text,
    'recorded-first-message:recorded-last-message',
    groupId
  );
  return scope === 'thread' ? group : `<thread id="${threadId}">\n${group}\n</thread>`;
}

/** Mastra OM's own observation token count (`TokenCounter.countObservations`). */
export function observationTokens(text: string): number {
  return new TokenCounter().countObservations(text);
}
