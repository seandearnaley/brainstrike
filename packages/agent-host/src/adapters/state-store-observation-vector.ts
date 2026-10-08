import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  StateMessageVectorPort,
  StateObservationPlan,
  StateObservationVectorPort,
} from '@brainstrike/indexer';
import type {
  CreateIndexParams,
  QueryResult,
  QueryVectorParams,
  UpsertVectorParams,
} from '@mastra/core/vector';
import {
  StateStoreMemoryVector,
  type StateStoreMemoryVectorOptions,
} from './state-store-memory-vector.js';
import type {
  NativeObservationInput,
  StateStoreObservationPreparation,
} from './state-store-observation-memory.js';

export interface StateStoreObservationVectorOptions extends StateStoreMemoryVectorOptions {
  readonly port: StateMessageVectorPort & StateObservationVectorPort;
}

/** Separate public observation DTO route over the SAME borrowed derived writer. */
export class StateStoreObservationVector
  extends StateStoreMemoryVector
  implements StateStoreObservationPreparation
{
  private readonly calls = new AsyncLocalStorage<StateObservationPlan>();
  private readonly captured: StateStoreObservationVectorOptions;
  private readonly observationIndex: string;
  private observationReady = false;

  constructor(options: StateStoreObservationVectorOptions) {
    super(options);
    this.captured = {
      port: options.port,
      profile: structuredClone(options.profile),
      scope: structuredClone(options.scope),
      signal: options.signal,
    };
    // Native pinned Memory's logical name, derived from its public separator.
    // https://github.com/mastra-ai/mastra/blob/@mastra/memory@1.32.1/packages/memory/src/index.ts
    this.observationIndex = `memory${this.indexSeparator}observations${this.indexSeparator}${options.profile.dimensions}`;
  }

  async withPreparedObservation(
    input: NativeObservationInput,
    index: () => Promise<void>
  ): Promise<void> {
    const { signal, scope, profile, port } = this.captured;
    signal.throwIfAborted();
    if (input.resourceId !== scope.resourceId) {
      throw new Error('Observation crossed its captured resource authority');
    }
    const observation = {
      groupId: input.groupId,
      range: input.range,
      text: input.text,
      threadId: input.threadId,
      ...(input.observedAt ? { observedAt: input.observedAt.toISOString() } : {}),
    };
    const plan = await port.prepareStateObservationVectors({
      observation,
      profile: structuredClone(profile),
      scope: structuredClone(scope),
    });
    signal.throwIfAborted();
    if (
      plan.scope.rootId !== scope.rootId ||
      plan.scope.resourceId !== scope.resourceId ||
      plan.scope.threadId !== scope.threadId ||
      plan.observation.groupId !== observation.groupId ||
      plan.observation.range !== observation.range ||
      plan.observation.text !== observation.text ||
      plan.observation.threadId !== observation.threadId ||
      plan.observation.observedAt !== observation.observedAt ||
      !plan.chunks.length
    ) {
      throw new Error('Prepared observation changed its committed source or invocation metadata');
    }
    // Every concurrent native call inherits its OWN immutable preparation.
    await this.calls.run(structuredClone(plan), index);
  }

  override async createIndex(params: CreateIndexParams): Promise<void> {
    if (params.indexName !== this.observationIndex) {
      return super.createIndex(params);
    }
    this.captured.signal.throwIfAborted();
    if (
      params.dimension !== this.captured.profile.dimensions ||
      (params.metric !== undefined && params.metric !== 'cosine')
    ) {
      throw new Error('Native observation index crossed its acquired profile');
    }
    this.observationReady = true;
  }

  override async upsert(params: UpsertVectorParams): Promise<string[]> {
    if (params.indexName !== this.observationIndex) {
      return super.upsert(params);
    }
    this.requireObservationIndex();
    const plan = this.calls.getStore();
    const ids = params.ids;
    const metadata = params.metadata;
    if (
      !(plan && ids && metadata) ||
      params.sparseVectors ||
      params.deleteFilter ||
      ids.length !== plan.chunks.length ||
      metadata.length !== plan.chunks.length ||
      params.vectors.length !== plan.chunks.length
    ) {
      throw new Error('Observation vector write requires its complete call-local committed plan');
    }
    const expected = plan.observation;
    const segments = params.vectors.map((vector, ordinal) => {
      validateVector(vector, this.captured.profile.dimensions);
      const row = metadata[ordinal];
      const id = ids[ordinal];
      const text = plan.chunks[ordinal];
      if (
        !id ||
        text === undefined ||
        !row ||
        Object.keys(row).some(
          (key) =>
            !['group_id', 'range', 'text', 'observed_at', 'thread_id', 'resource_id'].includes(key)
        ) ||
        row['group_id'] !== expected.groupId ||
        row['range'] !== expected.range ||
        row['text'] !== text ||
        row['observed_at'] !== expected.observedAt ||
        row['thread_id'] !== expected.threadId ||
        row['resource_id'] !== plan.scope.resourceId
      ) {
        throw new Error('Native observation metadata changed its prepared chunk or attribution');
      }
      return { id, text, vector: [...vector] };
    });
    const result = await this.captured.port.upsertStateObservationVectors({ plan, segments });
    if (result.length !== ids.length || result.some((id, ordinal) => id !== ids[ordinal])) {
      throw new Error('Observation writer changed the native vector identities');
    }
    return [...result];
  }

  override async query(params: QueryVectorParams): Promise<QueryResult[]> {
    if (params.indexName !== this.observationIndex) {
      return super.query(params);
    }
    this.requireObservationIndex();
    if (
      !params.queryVector ||
      params.sparseVector ||
      typeof params.topK !== 'number' ||
      !Number.isSafeInteger(params.topK) ||
      params.topK < 1 ||
      params.topK > 100
    ) {
      throw new Error('Observation query requires its acquired vector and explicit bounded limit');
    }
    validateVector(params.queryVector, this.captured.profile.dimensions);
    const filters = observationFilters(params.filter, this.captured.scope.resourceId);
    const hits = await this.captured.port.queryStateObservationVectors({
      ...filters,
      limit: params.topK,
      profile: structuredClone(this.captured.profile),
      scope: structuredClone(this.captured.scope),
      vector: [...params.queryVector],
    });
    return hits.map((hit) => {
      if (
        !(
          hit.id &&
          Number.isFinite(hit.score) &&
          hit.metadata.group_id &&
          hit.metadata.thread_id
        ) ||
        hit.metadata.resource_id !== this.captured.scope.resourceId ||
        (filters.threadIds && !filters.threadIds.includes(hit.metadata.thread_id))
      ) {
        throw new Error('Observation query result crossed its admitted source scope');
      }
      return { id: hit.id, metadata: structuredClone(hit.metadata), score: hit.score };
    });
  }

  override async listIndexes(): Promise<string[]> {
    return [
      ...(await super.listIndexes()),
      ...(this.observationReady ? [this.observationIndex] : []),
    ];
  }

  private requireObservationIndex(): void {
    this.captured.signal.throwIfAborted();
    if (!this.observationReady) {
      throw new Error('Observation call has no validated native logical index');
    }
  }
}

function validateVector(vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Native observation vector crossed its acquired dimensions');
  }
}

function observationFilters(
  input: unknown,
  resourceId: string
): {
  threadIds?: readonly string[];
  observedAfter?: string;
  observedBefore?: string;
} {
  if (
    !(input && typeof input === 'object' && !Array.isArray(input)) ||
    Object.keys(input).some((key) => !['resource_id', 'thread_id', 'observed_at'].includes(key)) ||
    Reflect.get(input, 'resource_id') !== resourceId
  ) {
    throw new Error('Observation query has no acquired resource filter');
  }
  const thread: unknown = Reflect.get(input, 'thread_id');
  if (thread !== undefined && (typeof thread !== 'string' || !thread.trim())) {
    throw new Error('Observation query has an invalid attributed thread filter');
  }
  const date: unknown = Reflect.get(input, 'observed_at');
  let observedAfter: string | undefined;
  let observedBefore: string | undefined;
  if (date !== undefined) {
    if (
      !(date && typeof date === 'object' && !Array.isArray(date) && Object.keys(date).length) ||
      Object.keys(date).some((key) => key !== '$gt' && key !== '$lt')
    ) {
      throw new Error('Observation query has an unsupported native date predicate');
    }
    observedAfter = isoDate(Reflect.get(date, '$gt'));
    observedBefore = isoDate(Reflect.get(date, '$lt'));
  }
  return {
    ...(typeof thread === 'string' ? { threadIds: [thread] } : {}),
    ...(observedAfter ? { observedAfter } : {}),
    ...(observedBefore ? { observedBefore } : {}),
  };
}

function isoDate(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('Observation query date is not the native exact ISO value');
  }
  return value;
}
