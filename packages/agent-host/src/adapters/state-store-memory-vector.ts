import type {
  StateMessageIdentity,
  StateMessagePlan,
  StateMessageScope,
  StateMessageVectorPort,
  VectorProfile,
} from '@brainstrike/indexer';
import {
  type CreateIndexParams,
  type DeleteIndexParams,
  type DeleteVectorParams,
  type DeleteVectorsParams,
  type DescribeIndexParams,
  type IndexStats,
  MastraVector,
  type QueryResult,
  type QueryVectorParams,
  type UpdateVectorParams,
  type UpsertVectorParams,
} from '@mastra/core/vector';

export interface StateStoreMemoryVectorOptions {
  /** Borrowed existing writer port. Root retains purge/close/reset ownership. */
  readonly port: StateMessageVectorPort;
  readonly profile: VectorProfile;
  readonly scope: StateMessageScope;
  readonly signal: AbortSignal;
}

/** Public Mastra DTO bridge; owns no index, inference loop, or durable identity. */
export class StateStoreMemoryVector extends MastraVector {
  private readonly profile: VectorProfile;
  private readonly scope: StateMessageScope;
  private readonly port: StateMessageVectorPort;
  private readonly signal: AbortSignal;
  private indexName: string | undefined;
  private preparing = false;
  private plan: StateMessagePlan | undefined;

  constructor(options: StateStoreMemoryVectorOptions) {
    super({ id: options.scope.resourceId });
    this.profile = structuredClone(options.profile);
    this.scope = structuredClone(options.scope);
    this.port = options.port;
    this.signal = options.signal;
    if (this.profile.distance !== 'cosine') {
      throw new Error('Public Memory requires the acquired cosine vector profile');
    }
  }

  assertOwner(resourceId: string, threadId: string, signal: AbortSignal): void {
    if (
      resourceId !== this.scope.resourceId ||
      threadId !== this.scope.threadId ||
      signal !== this.signal
    ) {
      throw new Error('Memory vector bridge crossed its captured run authority');
    }
  }

  /** Prepare before native saveMessages starts embedding; keep its unchanged plan. */
  async withPreparedMessages(
    messages: readonly StateMessageIdentity[],
    commit: () => Promise<void>
  ): Promise<void> {
    this.signal.throwIfAborted();
    if (this.preparing) {
      throw new Error('Memory vector commit is already admitted');
    }
    this.preparing = true;
    try {
      if (messages.length > 0) {
        this.plan = await this.port.prepareStateMessageVectors({
          messages: structuredClone(messages),
          profile: structuredClone(this.profile),
          scope: structuredClone(this.scope),
        });
      }
      this.signal.throwIfAborted();
      await commit();
    } finally {
      this.plan = undefined;
      this.preparing = false;
    }
  }

  private requireIndex(indexName: string): void {
    this.signal.throwIfAborted();
    if (indexName !== this.indexName) {
      throw new Error('Memory vector call has no validated logical index');
    }
  }

  override async createIndex(params: CreateIndexParams): Promise<void> {
    this.signal.throwIfAborted();
    if (
      !params.indexName.trim() ||
      params.dimension !== this.profile.dimensions ||
      (params.metric !== undefined && params.metric !== 'cosine') ||
      (this.indexName !== undefined && this.indexName !== params.indexName)
    ) {
      throw new Error('Native Memory index does not match the acquired vector profile');
    }
    // Logical vendor routing only; the acquired existing indexer owns physical schema.
    this.indexName = params.indexName;
  }

  override async upsert(params: UpsertVectorParams): Promise<string[]> {
    this.requireIndex(params.indexName);
    const plan = this.plan;
    if (!plan) {
      throw new Error('Memory vector write requires a pre-inference committed plan');
    }
    if (params.ids || params.sparseVectors || params.deleteFilter) {
      throw new Error('Native vector aliases and replacement filters are not admitted');
    }
    const embeddings = groupVectors(params, plan, this.scope, this.profile.dimensions);
    const result = await this.port.upsertStateMessageVectors({ embeddings, plan });
    const expected = new Map(plan.messages.map((message) => [message.messageId, message.seq]));
    const groups = new Map(
      embeddings.map((message) => [message.messageId, message.vectors.length])
    );
    const seen = new Map<string, Set<number>>();
    for (const message of result) {
      const ordinals = seen.get(message.messageId) ?? new Set<number>();
      if (
        expected.get(message.messageId) !== message.seq ||
        !Number.isSafeInteger(message.segmentOrdinal) ||
        message.segmentOrdinal < 0 ||
        message.segmentOrdinal >= (groups.get(message.messageId) ?? 0) ||
        ordinals.has(message.segmentOrdinal)
      ) {
        throw new Error('Indexer vector receipt changed its committed message identity');
      }
      ordinals.add(message.segmentOrdinal);
      seen.set(message.messageId, ordinals);
    }
    if (result.length !== params.vectors.length) {
      throw new Error('Indexer vector receipt omitted a native segment');
    }
    // Multiple segments intentionally return the same existing message ID.
    return result.map((message) => message.messageId);
  }

  override async query(params: QueryVectorParams): Promise<QueryResult[]> {
    this.requireIndex(params.indexName);
    if (params.includeVector || params.sparseVector || !params.queryVector) {
      throw new Error('Memory query requires its supported dense vector shape');
    }
    validateVector(params.queryVector, this.profile.dimensions);
    const limit = params.topK;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Memory query requires a positive explicit result limit');
    }
    const threadIds = queryThreads(params.filter, this.scope);
    const result = await this.port.queryStateMessageVectors({
      limit,
      profile: structuredClone(this.profile),
      scope: structuredClone(this.scope),
      ...(threadIds ? { threadIds } : {}),
      vector: [...params.queryVector],
    });
    return result.map((message) => {
      if (
        !(message.messageId && message.threadId && Number.isSafeInteger(message.seq)) ||
        message.seq < 1 ||
        !Number.isFinite(message.score) ||
        (threadIds !== undefined && !threadIds.includes(message.threadId))
      ) {
        throw new Error('Indexer query result crossed its admitted message scope');
      }
      return {
        id: message.messageId,
        metadata: {
          ['message_id']: message.messageId,
          ['resource_id']: this.scope.resourceId,
          ['thread_id']: message.threadId,
        },
        score: message.score,
      };
    });
  }

  override async listIndexes(): Promise<string[]> {
    this.signal.throwIfAborted();
    return this.indexName === undefined ? [] : [this.indexName];
  }
  override async describeIndex(_params: DescribeIndexParams): Promise<IndexStats> {
    throw new Error('Message index statistics belong to the existing indexer owner');
  }
  override async deleteIndex(_params: DeleteIndexParams): Promise<void> {
    throw new Error('Message index lifecycle belongs to Root purge/reset');
  }
  override async updateVector(_params: UpdateVectorParams): Promise<void> {
    throw new Error('Message vector mutation requires canonical committed source');
  }
  override async deleteVector(_params: DeleteVectorParams): Promise<void> {
    throw new Error('Message vector deletion belongs to Root purge');
  }
  override async deleteVectors(_params: DeleteVectorsParams): Promise<void> {
    throw new Error('Message vector deletion belongs to Root purge');
  }
}

function validateVector(vector: readonly number[], dimension: number): void {
  if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Native vector does not match the acquired dimensions');
  }
}

function queryThreads(filter: unknown, scope: StateMessageScope): string[] | undefined {
  if (!(filter && typeof filter === 'object' && !Array.isArray(filter))) {
    throw new Error('Memory vector query has no explicit resource/thread filter');
  }
  const keys = Object.keys(filter);
  if (!keys.length || keys.some((key) => key !== 'resource_id' && key !== 'thread_id')) {
    throw new Error('Memory vector query filter is outside the acquired scope contract');
  }
  const resource: unknown = Reflect.get(filter, 'resource_id');
  const thread: unknown = Reflect.get(filter, 'thread_id');
  if (
    (keys.includes('resource_id') && resource !== scope.resourceId) ||
    (keys.includes('thread_id') && thread !== scope.threadId)
  ) {
    throw new Error('Memory vector query filter crossed its captured authority');
  }
  return keys.includes('thread_id') ? [scope.threadId] : undefined;
}

function groupVectors(
  params: UpsertVectorParams,
  plan: StateMessagePlan,
  scope: StateMessageScope,
  dimension: number
): { messageId: string; vectors: number[][] }[] {
  const metadata = params.metadata;
  if (!metadata || metadata.length !== params.vectors.length || !metadata.length) {
    throw new Error('Memory vector write has no complete committed metadata');
  }
  const prepared = new Set(plan.messages.map((message) => message.messageId));
  const groups = new Map<string, number[][]>();
  for (const [index, vector] of params.vectors.entries()) {
    validateVector(vector, dimension);
    const row = metadata[index];
    const messageId: unknown = row?.['message_id'];
    if (
      typeof messageId !== 'string' ||
      !prepared.has(messageId) ||
      row?.['resource_id'] !== scope.resourceId ||
      row?.['thread_id'] !== scope.threadId
    ) {
      throw new Error('Native vector metadata has no prepared committed authority');
    }
    const vectors = groups.get(messageId) ?? [];
    vectors.push([...vector]);
    groups.set(messageId, vectors);
  }
  return [...groups].map(([messageId, vectors]) => ({ messageId, vectors }));
}
