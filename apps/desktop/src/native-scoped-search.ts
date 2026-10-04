import {
  embeddingProfileHash,
  type IndexerPort,
  type IndexFileBinding,
  type IndexScope,
  type ScopedCoverage,
  type ScopedIndexerPort,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import type {
  IndexerCoverage,
  IndexerCoverageBatch,
  IndexerCoverageRequest,
  IndexerEmbeddingState,
  IndexerSearchHit,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteQueryClient } from '@brainstrike/sqlite-query';
import type { NativeScopeReadiness } from './native-canonical-publication';
import { NativeCoverageObservationInvalidatedError } from './native-coverage-observation-invalidated';
import { grepSnapshot } from './native-index-search';

export interface NativeSearchAuthority {
  readonly bindings: readonly IndexFileBinding[];
  readonly collectionId: string;
  readonly generation: number;
  readonly profile: VectorProfile | null;
  readonly queryPlan: Extract<IndexerStatus, { kind: 'ready' }>['queryPlan'];
  readonly readiness: readonly NativeScopeReadiness[];
  readonly rootIds: readonly string[];
}
export interface NativeScopedRead {
  getAuthority(): Promise<NativeSearchAuthority>;
  readonly port: IndexerPort & ScopedIndexerPort;
}
interface Dependencies {
  openQuery(): Promise<Pick<SqliteQueryClient, 'grep' | 'close'>>;
  rebuild(): Promise<void>;
  withRead<T>(work: (read: NativeScopedRead) => Promise<T>): Promise<T>;
}
function embeddingState(profile: VectorProfile | null): IndexerEmbeddingState {
  if (profile === null) {
    return { indexMode: 'text-only' };
  }
  if (profile.provider !== 'local' && profile.provider !== 'transformers') {
    throw new Error('Native semantic execution requires an explicitly selected local profile.');
  }
  const { modelId, revision, dtype, dimensions, tokenCap } = profile;
  const projection = { dimensions, dtype, modelId, revision, tokenCap };
  return {
    indexMode: 'vector-configured',
    profile: projection,
    profileHash: embeddingProfileHash(projection),
  };
}
function fingerprint(authority: NativeSearchAuthority, includeReadiness: boolean): string {
  return JSON.stringify([
    authority.generation,
    authority.collectionId,
    authority.rootIds,
    authority.bindings,
    authority.profile,
    authority.queryPlan,
    ...(includeReadiness ? [authority.readiness] : []),
  ]);
}
function requestedScopes(
  authority: NativeSearchAuthority,
  request: {
    readonly rootIds: readonly string[];
    readonly collectionId?: string;
  }
): readonly IndexScope[] {
  if (
    new Set(request.rootIds).size !== request.rootIds.length ||
    request.rootIds.some((id) => !authority.rootIds.includes(id))
  ) {
    throw new Error('Native search scope is duplicated or no longer authorized.');
  }
  if (request.collectionId !== undefined) {
    if (request.collectionId !== authority.collectionId) {
      throw new Error('Native collection search is not authorized by current saved settings.');
    }
    return [{ embeddingSetId: request.collectionId, kind: 'collection' }];
  }
  if (request.rootIds.length === 0) {
    throw new Error('Native workspace search requires connected roots.');
  }
  return request.rootIds.map((rootId) => ({ kind: 'workspace', rootId }));
}
function selectedBindings(
  authority: NativeSearchAuthority,
  scopes: readonly IndexScope[]
): readonly IndexFileBinding[] {
  return authority.bindings.filter((file) =>
    scopes.some((scope) =>
      scope.kind === 'collection'
        ? file.embeddingSetId === scope.embeddingSetId
        : file.rootId === scope.rootId
    )
  );
}
function assertHits(
  hits: readonly IndexerSearchHit[],
  bindings: readonly IndexFileBinding[]
): void {
  for (const hit of hits) {
    const file = bindings.find((binding) => binding.fileId === hit.fileId);
    if (
      !file ||
      hit.rootId !== file.rootId ||
      hit.relativePath !== file.relativePath ||
      hit.embeddingSetId !== file.embeddingSetId ||
      hit.sourcePath !== file.sourcePath
    ) {
      throw new Error('Native search returned a stale or unauthorized canonical file binding.');
    }
  }
}
function assertCoverage(
  result: ScopedCoverage,
  storeId: string,
  profile: VectorProfile | null
): void {
  if (
    result.storeId !== storeId ||
    result.profileHash !== (profile === null ? null : vectorProfileHash(profile))
  ) {
    throw new Error('Native scope coverage returned a different store or profile.');
  }
}
function assertCoverageBatch(
  coverage: readonly ScopedCoverage[],
  scopes: readonly IndexScope[],
  storeId: string,
  profile: VectorProfile | null
): void {
  const first = coverage[0];
  if (!first || coverage.length !== scopes.length) {
    throw new Error('Native coverage batch returned a different scope inventory.');
  }
  for (const [index, result] of coverage.entries()) {
    assertCoverage(result, storeId, profile);
    const scope = scopes[index];
    if (
      !scope ||
      result.scope.kind !== scope.kind ||
      (result.scope.kind === 'workspace' && scope.kind === 'workspace'
        ? result.scope.rootId !== scope.rootId
        : result.scope.kind === 'collection' &&
          scope.kind === 'collection' &&
          result.scope.embeddingSetId !== scope.embeddingSetId)
    ) {
      throw new Error('Native coverage batch returned a different scope.');
    }
    if (
      result.authorityEpoch !== first.authorityEpoch ||
      result.authorityRevision !== first.authorityRevision
    ) {
      throw new Error('Native scope authority changed during coverage.');
    }
  }
}
function projectCoverage(
  coverage: readonly ScopedCoverage[],
  storeId: string,
  embedding: IndexerEmbeddingState
): IndexerCoverage {
  const totals = { chunks: 0, indexedFiles: 0, missingVectors: 0, vectors: 0 };
  for (const result of coverage) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[key] += result.counts[key];
    }
  }
  return {
    collections: coverage.flatMap((result) =>
      result.scope.kind === 'collection'
        ? [{ ...result.counts, embeddingSetId: result.scope.embeddingSetId }]
        : []
    ),
    embedding,
    roots: coverage.flatMap((result) =>
      result.scope.kind === 'workspace' ? [{ ...result.counts, rootId: result.scope.rootId }] : []
    ),
    storeId,
    totals,
    vectorCoverageComplete: coverage.every((result) => result.vectorCoverageComplete),
  };
}
function projectStatus(
  authority: NativeSearchAuthority,
  storeId: string,
  embedding: IndexerEmbeddingState
): Extract<IndexerStatus, { kind: 'ready' }> {
  return {
    authorizedCollectionIds: [authority.collectionId],
    authorizedRootIds: authority.rootIds,
    collectionReadiness: [
      {
        embeddingSetId: authority.collectionId,
        scanComplete: authority.readiness.some(
          (receipt) =>
            receipt.scope.kind === 'collection' &&
            receipt.scope.embeddingSetId === authority.collectionId &&
            receipt.scanComplete
        ),
      },
    ],
    embedding,
    kind: 'ready',
    rootReadiness: authority.rootIds.map((rootId) => ({
      rootId,
      scanComplete: authority.readiness.some(
        (receipt) =>
          receipt.scope.kind === 'workspace' &&
          receipt.scope.rootId === rootId &&
          receipt.scanComplete
      ),
    })),
    storeId,
    ...(authority.queryPlan === undefined ? {} : { queryPlan: authority.queryPlan }),
  };
}
/** Project the current scoped writer and its exact saved profile into the visible read capability. */
export function createNativeScopedSearchCapability(
  dependencies: Dependencies
): IndexSearchCapability {
  const capture = async (read: NativeScopedRead, includeReadiness = false) => {
    const port = read.port;
    const authority = await read.getAuthority();
    const info = await port.info();
    const key = fingerprint(authority, includeReadiness);
    return {
      assertCurrent: async (): Promise<void> => {
        const currentInfo = await port.info();
        if (
          key !== fingerprint(await read.getAuthority(), includeReadiness) ||
          currentInfo.storeId !== info.storeId
        ) {
          if (includeReadiness) {
            throw new NativeCoverageObservationInvalidatedError();
          }
          throw new Error('Native source or saved profile changed during search.');
        }
      },
      authority,
      embedding: embeddingState(authority.profile),
      port,
      storeId: info.storeId,
    };
  };
  const coverageBatch = (
    requests: readonly IndexerCoverageRequest[]
  ): Promise<IndexerCoverageBatch> =>
    dependencies.withRead(async (read) => {
      if (requests.length === 0) {
        throw new TypeError('Native coverage batch requires at least one request.');
      }
      const snapshot = await capture(read, true);
      const groups = requests.map((request) => requestedScopes(snapshot.authority, request));
      const scopes = groups.flat();
      let coverage: readonly ScopedCoverage[];
      try {
        coverage = await snapshot.port.coverageBatch(
          scopes.map((scope) => ({
            scope,
            ...(snapshot.authority.profile === null ? {} : { profile: snapshot.authority.profile }),
          }))
        );
      } catch (error) {
        if (error instanceof NativeCoverageObservationInvalidatedError) {
          return { code: error.code, kind: 'invalidated' };
        }
        throw error;
      }
      assertCoverageBatch(coverage, scopes, snapshot.storeId, snapshot.authority.profile);
      try {
        await snapshot.assertCurrent();
      } catch (error) {
        if (error instanceof NativeCoverageObservationInvalidatedError) {
          return { code: error.code, kind: 'invalidated' };
        }
        throw error;
      }
      let offset = 0;
      return {
        coverage: groups.map((group) => {
          const result = projectCoverage(
            coverage.slice(offset, offset + group.length),
            snapshot.storeId,
            snapshot.embedding
          );
          offset += group.length;
          return result;
        }),
        kind: 'current',
        status: projectStatus(snapshot.authority, snapshot.storeId, snapshot.embedding),
      };
    });
  return {
    coverage: async (request): Promise<IndexerCoverage> => {
      const observation = await coverageBatch([request]);
      if (observation.kind === 'invalidated') {
        throw new NativeCoverageObservationInvalidatedError();
      }
      const [result] = observation.coverage;
      if (!result) {
        throw new Error('Native singleton coverage returned no result.');
      }
      return result;
    },
    coverageBatch,
    grep: (request) =>
      dependencies.withRead(async (read) => {
        const snapshot = await capture(read);
        const scopes = requestedScopes(snapshot.authority, request);
        const bindings = selectedBindings(snapshot.authority, scopes);
        const result = await grepSnapshot(
          request,
          dependencies.openQuery,
          bindings.map((file) => file.fileId)
        );
        if (result.storeId !== snapshot.storeId) {
          throw new Error('Native grep returned a different store.');
        }
        assertHits(result.hits, bindings);
        await snapshot.assertCurrent();
        return {
          ...result,
          embedding: snapshot.embedding,
          scanLimited:
            result.scanLimited ||
            scopes.some(
              (scope) =>
                !snapshot.authority.readiness.some(
                  (receipt) =>
                    receipt.scanComplete &&
                    (scope.kind === 'workspace' && receipt.scope.kind === 'workspace'
                      ? scope.rootId === receipt.scope.rootId
                      : scope.kind === 'collection' &&
                        receipt.scope.kind === 'collection' &&
                        scope.embeddingSetId === receipt.scope.embeddingSetId)
                )
            ),
        };
      }),
    rebuild: () => dependencies.rebuild(),
    search: (request) =>
      dependencies.withRead(async (read) => {
        const snapshot = await capture(read);
        const scopes = requestedScopes(snapshot.authority, request);
        if (
          request.mode === 'vector' &&
          (snapshot.embedding.indexMode !== 'vector-configured' ||
            embeddingProfileHash(request.profile) !== snapshot.embedding.profileHash)
        ) {
          throw new Error('Native query profile differs from the explicitly saved scoped profile.');
        }
        const result = await snapshot.port.searchScopes({
          limit: request.limit,
          mode: request.mode,
          scopes,
          ...(request.mode === 'vector'
            ? { profile: snapshot.authority.profile, vector: request.vector }
            : { text: request.text }),
        });
        if (
          result.storeId !== snapshot.storeId ||
          (request.mode === 'vector' &&
            result.profileHash !== vectorProfileHash(snapshot.authority.profile))
        ) {
          throw new Error('Scoped native search returned a different store or vector profile.');
        }
        assertHits(result.hits, selectedBindings(snapshot.authority, scopes));
        await snapshot.assertCurrent();
        return {
          ...result,
          embedding: snapshot.embedding,
          scanLimited:
            result.scanLimited ||
            scopes.some(
              (scope) =>
                !snapshot.authority.readiness.some(
                  (receipt) =>
                    receipt.scanComplete &&
                    (scope.kind === 'workspace' && receipt.scope.kind === 'workspace'
                      ? scope.rootId === receipt.scope.rootId
                      : scope.kind === 'collection' &&
                        receipt.scope.kind === 'collection' &&
                        scope.embeddingSetId === receipt.scope.embeddingSetId)
                )
            ),
        };
      }),
    status: async () => {
      try {
        return await dependencies.withRead(async (read) => {
          const snapshot = await capture(read);
          await snapshot.assertCurrent();
          return projectStatus(snapshot.authority, snapshot.storeId, snapshot.embedding);
        });
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
