import type { IndexerStatus } from '../../../../packages/indexing-contract/src/indexer-client';
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
  readonly receipts: readonly Receipt[];
} {
  const receipts = [
    scopeReceipt('workspace', status.authorizedRootIds, status.rootReadiness),
    scopeReceipt('collection', status.authorizedCollectionIds, status.collectionReadiness),
  ];
  const embedding = embeddingIdentity(status.embedding);
  const queryPlan = queryIdentity(status.queryPlan);
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
    receipts,
  };
}

export function createBenchmarkProgress(dependencies: Dependencies): {
  assertLive(): void;
  observe(): Promise<NativeSnapshot | null>;
} {
  const baseline = inspectStatus(dependencies.baseline);
  // Historical scope milestones only: the public DTO does not expose scan generation/epoch.
  const credited = new Set(
    baseline.receipts
      .filter((receipt) => receipt.complete)
      .map((receipt) => JSON.stringify(receipt.scope))
  );
  let lastProvedAt = dependencies.startedAt;
  let previousCounts = '';
  let baselineRecorded = false;
  const acceptStatus = async (status: ReadyStatus): Promise<void> => {
    const current = inspectStatus(status);
    if (current.identity !== baseline.identity) {
      throw new Error('Benchmark publication identity changed.');
    }
    for (const receipt of current.receipts) {
      const key = JSON.stringify(receipt.scope);
      if (!receipt.complete || credited.has(key)) {
        continue;
      }
      credited.add(key);
      lastProvedAt = dependencies.now();
      await dependencies.record('benchmark-proved-progress', {
        atMs: lastProvedAt,
        elapsedMs: lastProvedAt - dependencies.startedAt,
        identity: baseline.identity,
        scope: receipt.scope,
        source: 'historical-scope-publication',
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
          atMs: dependencies.startedAt,
          creditedScopes: [...credited],
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
