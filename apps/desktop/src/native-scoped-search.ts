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
  IndexerEmbeddingState,
  IndexerSearchHit,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteQueryClient } from '@brainstrike/sqlite-query';
import { grepSnapshot } from './native-index-search';

export interface NativeSearchAuthority {
  readonly bindings: readonly IndexFileBinding[];
  readonly collectionId: string;
  readonly generation: number;
  readonly profile: VectorProfile | null;
  readonly queryPlan: Extract<IndexerStatus, { kind: 'ready' }>['queryPlan'];
  readonly readiness: readonly { readonly scope: IndexScope; readonly scanComplete: boolean }[];
  readonly rootIds: readonly string[];
}
interface Dependencies {
  acquireIndexer(): Promise<IndexerPort & ScopedIndexerPort>;
  getAuthority(): Promise<NativeSearchAuthority>;
  openQuery(): Promise<Pick<SqliteQueryClient, 'grep' | 'close'>>;
  rebuild(): Promise<void>;
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
function fingerprint(authority: NativeSearchAuthority): string {
  return JSON.stringify([
    authority.generation,
    authority.collectionId,
    authority.rootIds,
    authority.bindings,
    authority.profile,
    authority.queryPlan,
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
/** Project the current scoped writer and its exact saved profile into the visible read capability. */
export function createNativeScopedSearchCapability(
  dependencies: Dependencies
): IndexSearchCapability {
  const capture = async () => {
    const port = await dependencies.acquireIndexer();
    const authority = await dependencies.getAuthority();
    const info = await port.info();
    const key = fingerprint(authority);
    return {
      assertCurrent: async (): Promise<void> => {
        if (
          key !== fingerprint(await dependencies.getAuthority()) ||
          (await port.info()).storeId !== info.storeId
        ) {
          throw new Error('Native source or saved profile changed during search.');
        }
      },
      authority,
      embedding: embeddingState(authority.profile),
      port,
      storeId: info.storeId,
    };
  };
  return {
    coverage: async (request): Promise<IndexerCoverage> => {
      const snapshot = await capture();
      const scopes = requestedScopes(snapshot.authority, request);
      const coverage: ScopedCoverage[] = [];
      for (const scope of scopes) {
        const result = await snapshot.port.coverageScope({
          scope,
          ...(snapshot.authority.profile === null ? {} : { profile: snapshot.authority.profile }),
        });
        if (
          result.storeId !== snapshot.storeId ||
          result.profileHash !==
            (snapshot.authority.profile === null
              ? null
              : vectorProfileHash(snapshot.authority.profile))
        ) {
          throw new Error('Native scope coverage returned a different store or profile.');
        }
        coverage.push(result);
      }
      if (
        coverage.some(
          (result) =>
            result.authorityEpoch !== coverage[0]?.authorityEpoch ||
            result.authorityRevision !== coverage[0]?.authorityRevision
        )
      ) {
        throw new Error('Native scope authority changed during coverage.');
      }
      await snapshot.assertCurrent();
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
        embedding: snapshot.embedding,
        roots: coverage.flatMap((result) =>
          result.scope.kind === 'workspace'
            ? [{ ...result.counts, rootId: result.scope.rootId }]
            : []
        ),
        storeId: snapshot.storeId,
        totals,
        vectorCoverageComplete: coverage.every((result) => result.vectorCoverageComplete),
      };
    },
    grep: async (request) => {
      const snapshot = await capture();
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
    },
    rebuild: () => dependencies.rebuild(),
    search: async (request) => {
      const snapshot = await capture();
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
    },
    status: async () => {
      try {
        const snapshot = await capture();
        await snapshot.assertCurrent();
        return {
          authorizedCollectionIds: [snapshot.authority.collectionId],
          authorizedRootIds: snapshot.authority.rootIds,
          collectionReadiness: [
            {
              embeddingSetId: snapshot.authority.collectionId,
              scanComplete: snapshot.authority.readiness.some(
                (receipt) =>
                  receipt.scope.kind === 'collection' &&
                  receipt.scope.embeddingSetId === snapshot.authority.collectionId &&
                  receipt.scanComplete
              ),
            },
          ],
          embedding: snapshot.embedding,
          kind: 'ready',
          rootReadiness: snapshot.authority.rootIds.map((rootId) => ({
            rootId,
            scanComplete: snapshot.authority.readiness.some(
              (receipt) =>
                receipt.scope.kind === 'workspace' &&
                receipt.scope.rootId === rootId &&
                receipt.scanComplete
            ),
          })),
          storeId: snapshot.storeId,
          ...(snapshot.authority.queryPlan === undefined
            ? {}
            : { queryPlan: snapshot.authority.queryPlan }),
        };
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
