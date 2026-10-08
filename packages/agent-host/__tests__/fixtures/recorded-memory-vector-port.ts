import type {
  StateMessageHit,
  StateMessagePlan,
  StateMessagePrepare,
  StateMessageQuery,
  StateMessageUpsert,
  StateMessageVectorPort,
  VectorProfile,
} from '@brainstrike/indexer';

export const RECORDED_VECTOR_PROFILE: VectorProfile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'fp32',
  modelId: 'deterministic-fixture-384',
  provider: 'local',
  revision: 'd'.repeat(40),
  tokenCap: 512,
};

/** Call recorder only. It stores no vectors and is not an indexer parity proof. */
export function recordedMemoryVectorPort() {
  const prepares: StateMessagePrepare[] = [];
  const plans: StateMessagePlan[] = [];
  const upserts: StateMessageUpsert[] = [];
  const queries: StateMessageQuery[] = [];
  const events: string[] = [];
  let hits: readonly StateMessageHit[] = [];
  let prepareFailure: unknown;
  const port: StateMessageVectorPort = {
    prepareStateMessageVectors: async (request) => {
      prepares.push(structuredClone(request));
      events.push('prepare');
      if (prepareFailure !== undefined) {
        throw prepareFailure;
      }
      const plan: StateMessagePlan = {
        ...structuredClone(request),
        generation: 0,
        storeId: '1'.repeat(64),
        truthHash: '2'.repeat(64),
      };
      plans.push(plan);
      return plan;
    },
    purgeStateMessageVectors: async () => {
      throw new Error('Purge remains existing Root/indexer owned');
    },
    queryStateMessageVectors: async (request) => {
      queries.push(structuredClone(request));
      events.push('query');
      return structuredClone(hits);
    },
    upsertStateMessageVectors: async (request) => {
      upserts.push(request);
      events.push('upsert');
      return request.embeddings.flatMap(({ messageId, vectors }) => {
        const identity = request.plan.messages.find((message) => message.messageId === messageId);
        if (!identity) {
          throw new Error('Recorded call has an unprepared identity');
        }
        return vectors.map((_vector, segmentOrdinal) => ({ ...identity, segmentOrdinal }));
      });
    },
  };
  return {
    events,
    plans,
    port,
    prepares,
    queries,
    setHits(value: readonly StateMessageHit[]): void {
      hits = structuredClone(value);
    },
    setPrepareFailure(value: unknown): void {
      prepareFailure = value;
    },
    upserts,
  };
}
