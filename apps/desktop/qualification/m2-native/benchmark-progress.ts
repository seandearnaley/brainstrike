import type {
  IndexerPublicationProgress,
  IndexerStatus,
} from '../../../../packages/indexing-contract/src/indexer-client';
import type { NativeSnapshot } from './candidate';

interface Dependencies {
  readonly baseline: Extract<IndexerStatus, { kind: 'ready' }>;
  now(): number;
  readCoverage(): Promise<NativeSnapshot | null>;
  readStatus(): Promise<IndexerStatus>;
  record(phase: string, value: unknown): Promise<void>;
  readonly startedAt: number;
}

type ReadyStatus = Extract<IndexerStatus, { kind: 'ready' }>;
function scopeKey(scope: IndexerPublicationProgress['scope']): string {
  return JSON.stringify([
    scope.kind,
    scope.kind === 'workspace' ? scope.rootId : scope.embeddingSetId,
  ]);
}
interface Receipt {
  readonly complete: boolean;
  readonly scope:
    | { readonly kind: 'workspace'; readonly rootId: string }
    | { readonly embeddingSetId: string; readonly kind: 'collection' };
}

function scopeReceipt(
  kind: 'workspace' | 'collection',
  ids: readonly string[] | undefined,
  receipts:
    | readonly {
        readonly embeddingSetId?: string;
        readonly rootId?: string;
        readonly scanComplete: boolean;
      }[]
    | undefined
): Receipt {
  const id = ids?.[0];
  const receipt = receipts?.[0];
  if (
    !Array.isArray(ids) ||
    ids.length !== 1 ||
    typeof id !== 'string' ||
    !id.trim() ||
    !Array.isArray(receipts) ||
    receipts.length !== 1 ||
    !receipt ||
    typeof receipt.scanComplete !== 'boolean' ||
    (kind === 'workspace' ? receipt.rootId : receipt.embeddingSetId) !== id
  ) {
    throw new Error('Benchmark publication scope inventory changed or is incomplete.');
  }
  return {
    complete: receipt.scanComplete,
    scope: kind === 'workspace' ? { kind, rootId: id } : { embeddingSetId: id, kind },
  };
}

function embeddingIdentity(embedding: ReadyStatus['embedding']): readonly unknown[] {
  if (embedding.indexMode === 'text-only') {
    return [embedding.indexMode];
  }
  const { profile } = embedding;
  if (!profile) {
    throw new Error('Benchmark publication profile identity is incomplete.');
  }
  return [
    embedding.indexMode,
    embedding.profileHash,
    profile.modelId,
    profile.revision,
    profile.dtype,
    profile.dimensions,
    profile.tokenCap,
  ];
}

function queryIdentity(plan: ReadyStatus['queryPlan']): readonly unknown[] | null {
  if (plan === undefined) {
    return null;
  }
  if (!plan.inferencePlan) {
    throw new Error('Benchmark publication query identity is incomplete.');
  }
  return [
    plan.modelKey,
    plan.inferencePlan.modelId,
    plan.inferencePlan.revision,
    plan.inferencePlan.dtype,
    plan.inferencePlan.dimensions,
    plan.inferencePlan.device,
  ];
}

function inspectStatus(status: ReadyStatus): {
  readonly identity: string;
  readonly publications: readonly IndexerPublicationProgress[];
} {
  const receipts = [
    scopeReceipt('workspace', status.authorizedRootIds, status.rootReadiness),
    scopeReceipt('collection', status.authorizedCollectionIds, status.collectionReadiness),
  ];
  const embedding = embeddingIdentity(status.embedding);
  const queryPlan = queryIdentity(status.queryPlan);
  const publications = status.publicationProgress;
  const scopes = new Set(receipts.map(({ scope }) => scopeKey(scope)));
  const seen = new Set<string>();
  if (!Array.isArray(publications)) {
    throw new Error('Benchmark native publication progress is missing.');
  }
  for (const publication of publications) {
    const key = scopeKey(publication.scope);
    if (
      !scopes.has(key) ||
      seen.has(key) ||
      publication.storeId !== status.storeId ||
      publication.profileHash !==
        (status.embedding.indexMode === 'text-only' ? null : status.embedding.profileHash) ||
      !publication.requestId?.trim() ||
      !publication.authorityEpoch?.trim() ||
      ![
        publication.acknowledgedFiles,
        publication.scanGeneration,
        publication.authorityRevision,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      ![publication.ownerGeneration, publication.mutationRevision].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      )
    ) {
      throw new Error('Benchmark native publication progress identity or inventory is invalid.');
    }
    seen.add(key);
  }
  if (
    !status.storeId?.trim() ||
    [...embedding, ...(queryPlan === null ? [] : queryPlan)].some(
      (value) => value === undefined || value === null
    )
  ) {
    throw new Error('Benchmark publication identity is incomplete.');
  }
  return {
    identity: JSON.stringify({
      authorizedCollectionIds: status.authorizedCollectionIds,
      authorizedRootIds: status.authorizedRootIds,
      collectionReadinessIds: status.collectionReadiness?.map((receipt) => receipt.embeddingSetId),
      embedding,
      queryPlan,
      rootReadinessIds: status.rootReadiness.map((receipt) => receipt.rootId),
      storeId: status.storeId,
    }),
    publications,
  };
}

export function createBenchmarkProgress(dependencies: Dependencies): {
  assertLive(): void;
  observe(): Promise<NativeSnapshot | null>;
} {
  const baseline = inspectStatus(dependencies.baseline);
  const acknowledged = new Map<string, { readonly identity: string; count: number }>();
  let ownerGeneration: number | undefined;
  const publicationIdentity = (publication: IndexerPublicationProgress): string =>
    JSON.stringify([
      publication.ownerGeneration,
      publication.scanGeneration,
      publication.requestId,
    ]);
  for (const publication of baseline.publications) {
    ownerGeneration ??= publication.ownerGeneration;
    if (ownerGeneration !== publication.ownerGeneration) {
      throw new Error('Benchmark publication owner changed.');
    }
    acknowledged.set(scopeKey(publication.scope), {
      count: publication.acknowledgedFiles,
      identity: publicationIdentity(publication),
    });
  }
  let lastProvedAt = dependencies.startedAt;
  let previousCounts = '';
  let baselineRecorded = false;
  const acceptStatus = async (status: ReadyStatus): Promise<void> => {
    const current = inspectStatus(status);
    if (current.identity !== baseline.identity) {
      throw new Error('Benchmark publication identity changed.');
    }
    for (const publication of current.publications) {
      ownerGeneration ??= publication.ownerGeneration;
      const key = scopeKey(publication.scope);
      const identity = publicationIdentity(publication);
      const previous = acknowledged.get(key);
      if (
        ownerGeneration !== publication.ownerGeneration ||
        (previous && previous.identity !== identity)
      ) {
        throw new Error('Benchmark publication owner or scan generation changed.');
      }
      if (publication.acknowledgedFiles <= (previous?.count ?? 0)) {
        continue;
      }
      acknowledged.set(key, { count: publication.acknowledgedFiles, identity });
      lastProvedAt = dependencies.now();
      await dependencies.record('benchmark-proved-progress', {
        atMs: lastProvedAt,
        elapsedMs: lastProvedAt - dependencies.startedAt,
        identity: baseline.identity,
        publication,
        source: 'acknowledged-publication',
      });
    }
  };
  return {
    assertLive: (): void => {
      if (dependencies.now() - lastProvedAt > 200_000) {
        throw new Error('Native build made no progress for the preserved 200-second stall window.');
      }
    },
    observe: async (): Promise<NativeSnapshot | null> => {
      if (!baselineRecorded) {
        baselineRecorded = true;
        await dependencies.record('benchmark-progress-baseline', {
          acknowledgedScopes: baseline.publications,
          atMs: dependencies.startedAt,
          identity: baseline.identity,
        });
      }
      const status = await dependencies.readStatus();
      if (status.kind === 'ready') {
        await acceptStatus(status);
      }
      const observation = await dependencies.readCoverage();
      if (observation?.status.kind === 'ready') {
        await acceptStatus(observation.status);
        if (!(observation.coverage && observation.collectionCoverage)) {
          throw new Error('Benchmark current coverage scope inventory is incomplete.');
        }
        const counts = JSON.stringify([
          observation.coverage.totals,
          observation.collectionCoverage.totals,
        ]);
        if (counts !== previousCounts) {
          previousCounts = counts;
          lastProvedAt = dependencies.now();
          await dependencies.record('benchmark-proved-progress', {
            atMs: lastProvedAt,
            counts,
            elapsedMs: lastProvedAt - dependencies.startedAt,
            identity: baseline.identity,
            source: 'coverage-counts',
          });
        }
      }
      return observation;
    },
  };
}
