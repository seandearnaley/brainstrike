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
  IndexChunkBoundsCapability,
  IndexerCoverage,
  IndexerCoverageBatch,
  IndexerCoverageRequest,
  IndexerEmbeddingState,
  IndexerFileChunks,
  IndexerFileChunksRequest,
  IndexerFileChunksResult,
  IndexerSearchHit,
  IndexerSourceObservation,
  IndexerStatus,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteQueryClient } from '@brainstrike/sqlite-query';
import { NativeAuthorityTransitionError, NativeIndexRefusalError } from './errors.js';
import { grepSnapshot } from './index-search.js';
import type { NativeScopeReadiness } from './read-contracts.js';

export interface NativeSearchAuthority {
  readonly bindings: readonly IndexFileBinding[];
  /** The saved collection, or null for the TEXT partition: workspace scopes only (BST-1988). */
  readonly collectionId: string | null;
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

export interface NativeScopedSearchDependencies {
  openQuery(): Promise<Pick<SqliteQueryClient, 'grep' | 'close'>>;
  rebuild(): Promise<void>;
  withRead<T>(work: (read: NativeScopedRead) => Promise<T>): Promise<T>;
}
function embeddingState(profile: VectorProfile | null): IndexerEmbeddingState {
  if (profile === null) {
    return { indexMode: 'text-only' };
  }
  if (
    (profile.provider !== 'local' && profile.provider !== 'transformers') ||
    profile.revision === undefined ||
    profile.tokenCap === undefined ||
    profile.dtype === 'q4' ||
    profile.distance !== 'cosine'
  ) {
    return {
      indexMode: 'vector-configured',
      profile: {
        dimensions: profile.dimensions,
        distance: profile.distance,
        modelId: profile.modelId,
        provider: profile.provider,
        ...('dtype' in profile ? { dtype: profile.dtype } : {}),
        ...('pooling' in profile && profile.pooling !== undefined
          ? { pooling: profile.pooling }
          : {}),
        ...('prompts' in profile && profile.prompts !== undefined
          ? { prompts: profile.prompts }
          : {}),
        ...('revision' in profile && profile.revision !== undefined
          ? { revision: profile.revision }
          : {}),
        ...('tokenCap' in profile && profile.tokenCap !== undefined
          ? { tokenCap: profile.tokenCap }
          : {}),
      },
      profileHash: vectorProfileHash(profile),
    };
  }
  const { modelId, revision, dtype, dimensions, tokenCap } = profile;
  const projection = {
    dimensions,
    dtype,
    modelId,
    ...(profile.pooling === undefined ? {} : { pooling: profile.pooling }),
    ...(profile.prompts === undefined ? {} : { prompts: profile.prompts }),
    revision,
    tokenCap,
  };
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
/** Completeness is a proof about this observation, not permission to read committed rows. */
function observedAuthority(
  captured: NativeSearchAuthority,
  current: NativeSearchAuthority
): NativeSearchAuthority {
  return {
    ...captured,
    readiness: captured.readiness.map((receipt) => {
      const matching = current.readiness.find(
        (candidate) => JSON.stringify(candidate.scope) === JSON.stringify(receipt.scope)
      );
      if (JSON.stringify(receipt) === JSON.stringify(matching)) {
        return receipt;
      }
      // A scan, commit or publication advanced while the read was in flight.
      // Keep its committed data usable, without pairing it with a later proof.
      const { publication: _publication, ...partial } = receipt;
      return { ...partial, scanComplete: false };
    }),
  };
}
function completeSourceScopes(
  scopes: readonly IndexScope[],
  readiness: readonly NativeScopeReadiness[]
): boolean {
  return scopes.every((scope) =>
    readiness.some(
      (receipt) =>
        receipt.scanComplete &&
        (scope.kind === 'workspace' && receipt.scope.kind === 'workspace'
          ? scope.rootId === receipt.scope.rootId
          : scope.kind === 'collection' &&
            receipt.scope.kind === 'collection' &&
            scope.embeddingSetId === receipt.scope.embeddingSetId)
    )
  );
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
function projectSourceObservation(authority: NativeSearchAuthority): IndexerSourceObservation {
  return {
    ownerGeneration: authority.generation,
    readiness: authority.readiness.map(({ generation, mutationRevision, scanComplete, scope }) => ({
      generation,
      mutationRevision,
      scanComplete,
      scope,
    })),
  };
}
function projectStatus(
  authority: NativeSearchAuthority,
  storeId: string,
  embedding: IndexerEmbeddingState
): Extract<IndexerStatus, { kind: 'ready' }> {
  const { collectionId } = authority;
  return {
    authorizedCollectionIds: collectionId === null ? [] : [collectionId],
    authorizedRootIds: authority.rootIds,
    collectionReadiness:
      collectionId === null
        ? []
        : [
            {
              embeddingSetId: collectionId,
              scanComplete: authority.readiness.some(
                (receipt) =>
                  receipt.scope.kind === 'collection' &&
                  receipt.scope.embeddingSetId === collectionId &&
                  receipt.scanComplete
              ),
            },
          ],
    embedding,
    kind: 'ready',
    publicationProgress: authority.readiness.flatMap(
      ({ generation: scanGeneration, publication, scope }) => {
        if (!publication) {
          return [];
        }
        const selectedHash =
          authority.profile === null ? null : vectorProfileHash(authority.profile);
        if (
          publication.storeId !== storeId ||
          publication.profileHash !== selectedHash ||
          publication.generation !== scanGeneration ||
          (scope.kind === 'workspace'
            ? !authority.rootIds.includes(scope.rootId)
            : scope.embeddingSetId !== authority.collectionId)
        ) {
          throw new Error(
            'Native publication progress differs from the current store, profile, generation or scope.'
          );
        }
        const { generation, ...acknowledged } = publication;
        return [
          {
            ...acknowledged,
            ownerGeneration: authority.generation,
            profileHash: embedding.indexMode === 'text-only' ? null : embedding.profileHash,
            scanGeneration: generation,
            scope,
          },
        ];
      }
    ),
    rootReadiness: authority.rootIds.map((rootId) => ({
      rootId,
      scanComplete: authority.readiness.some(
        (receipt) =>
          receipt.scope.kind === 'workspace' &&
          receipt.scope.rootId === rootId &&
          receipt.scanComplete
      ),
    })),
    sourceObservation: projectSourceObservation(authority),
    storeId,
    ...(authority.queryPlan === undefined ? {} : { queryPlan: authority.queryPlan }),
  };
}
const MAX_FILE_CHUNK_PATHS = 100;

/** A root-relative path as bindings hold it: POSIX, without the explorer's leading slash. */
function bindingPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

async function readFileChunks(
  snapshot: {
    readonly assertCurrent: () => Promise<NativeSearchAuthority>;
    readonly authority: NativeSearchAuthority;
    readonly port: NativeScopedRead['port'];
    readonly storeId: string;
  },
  request: IndexerFileChunksRequest
): Promise<IndexerFileChunksResult> {
  if (request.paths.length === 0 || request.paths.length > MAX_FILE_CHUNK_PATHS) {
    throw new TypeError(`Native file chunks need 1 to ${MAX_FILE_CHUNK_PATHS} paths.`);
  }
  const bound = new Map(
    snapshot.authority.bindings
      .filter((binding) => binding.rootId === request.rootId && binding.relativePath !== null)
      .map((binding) => [binding.relativePath, binding.fileId])
  );
  const fileIds = [...new Set(request.paths.flatMap((path) => bound.get(bindingPath(path)) ?? []))];
  const read =
    fileIds.length === 0
      ? undefined
      : await snapshot.port.readScopedFileChunkBounds({
          fileIds,
          scope: { kind: 'workspace', rootId: request.rootId },
        });
  if (read && read.storeId !== snapshot.storeId) {
    throw new Error('Native file chunks returned a different store.');
  }
  const byFile = new Map(read?.files.map((file) => [file.fileId, file]));
  const files = request.paths.map((path): IndexerFileChunks => {
    const fileId = bound.get(bindingPath(path));
    const file = fileId === undefined ? undefined : byFile.get(fileId);
    if (!file) {
      return { kind: 'outside-index', path };
    }
    if (file.kind === 'not-indexed') {
      return { kind: 'not-indexed', path };
    }
    return { chunks: file.chunks, contentHash: file.contentHash, kind: 'indexed', path };
  });
  await snapshot.assertCurrent();
  return { files, rootId: request.rootId, storeId: snapshot.storeId };
}

/** Project the current scoped writer and its exact saved profile into the visible read capability. */
export function createNativeScopedSearchCapability(
  dependencies: NativeScopedSearchDependencies
): IndexSearchCapability & IndexChunkBoundsCapability {
  const capture = async (read: NativeScopedRead) => {
    const port = read.port;
    const authority = await read.getAuthority();
    const info = await port.info();
    const embedding = embeddingState(authority.profile);
    projectStatus(authority, info.storeId, embedding);
    const key = fingerprint(authority);
    return {
      assertCurrent: async (): Promise<NativeSearchAuthority> => {
        const currentInfo = await port.info();
        if (currentInfo.storeId !== info.storeId) {
          throw new Error('Native store changed during search.');
        }
        const currentAuthority = await read.getAuthority();
        if (key !== fingerprint(currentAuthority)) {
          throw new NativeAuthorityTransitionError(
            'Native source or saved profile changed during search.'
          );
        }
        // Validate progress identity before discarding an obsolete completeness proof.
        projectStatus(currentAuthority, info.storeId, embedding);
        return observedAuthority(authority, currentAuthority);
      },
      authority,
      embedding,
      port,
      storeId: info.storeId,
    };
  };
  const coverageBatch = async (
    requests: readonly IndexerCoverageRequest[]
  ): Promise<IndexerCoverageBatch> => {
    try {
      return await dependencies.withRead(async (read) => {
        if (requests.length === 0) {
          throw new TypeError('Native coverage batch requires at least one request.');
        }
        const snapshot = await capture(read);
        const groups = requests.map((request) => requestedScopes(snapshot.authority, request));
        const scopes = groups.flat();
        const coverage = await snapshot.port.coverageBatch(
          scopes.map((scope) => ({
            scope,
            ...(snapshot.authority.profile === null ? {} : { profile: snapshot.authority.profile }),
          }))
        );
        assertCoverageBatch(coverage, scopes, snapshot.storeId, snapshot.authority.profile);
        const observed = await snapshot.assertCurrent();
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
          status: projectStatus(observed, snapshot.storeId, snapshot.embedding),
        };
      });
    } catch (error) {
      if (error instanceof NativeIndexRefusalError) {
        if (error.refusal.kind === 'setup-required') {
          throw error;
        }
        if (error.refusal.kind === 'transitioning' || error.refusal.kind === 'closed') {
          return {
            cause: error.refusal,
            code: 'native-coverage-observation-invalidated',
            kind: 'invalidated',
          };
        }
        return { cause: error.refusal, kind: 'blocked', reason: error.message };
      }
      throw error;
    }
  };
  return {
    coverage: async (request): Promise<IndexerCoverage> => {
      const observation = await coverageBatch([request]);
      if (observation.kind === 'blocked') {
        throw new Error(observation.reason);
      }
      if (observation.kind === 'invalidated') {
        throw new NativeAuthorityTransitionError(
          'Native source or saved profile changed during search.'
        );
      }
      const [result] = observation.coverage;
      if (!result) {
        throw new Error('Native singleton coverage returned no result.');
      }
      return result;
    },
    coverageBatch,
    fileChunks: (request) =>
      dependencies.withRead(async (read) => readFileChunks(await capture(read), request)),
    grep: (request) =>
      dependencies.withRead(async (read) => {
        const snapshot = await capture(read);
        const scopes = requestedScopes(snapshot.authority, request);
        const bindings = selectedBindings(snapshot.authority, scopes).filter(
          (file) =>
            request.filePaths === undefined ||
            (file.relativePath !== null && request.filePaths.includes(file.relativePath))
        );
        const result = await grepSnapshot(
          request,
          dependencies.openQuery,
          bindings.map((file) => file.fileId)
        );
        if (result.storeId !== snapshot.storeId) {
          throw new Error('Native grep returned a different store.');
        }
        assertHits(result.hits, bindings);
        const observed = await snapshot.assertCurrent();
        const sourceComplete = completeSourceScopes(scopes, observed.readiness);
        return {
          ...result,
          embedding: snapshot.embedding,
          scanLimited: result.scanLimited || !sourceComplete,
          sourceComplete,
          sourceObservation: projectSourceObservation(observed),
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
            (request.profile.provider === undefined
              ? embeddingProfileHash(request.profile)
              : vectorProfileHash(request.profile)) !== snapshot.embedding.profileHash)
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
        const observed = await snapshot.assertCurrent();
        const sourceComplete = completeSourceScopes(scopes, observed.readiness);
        return {
          ...result,
          embedding: snapshot.embedding,
          scanLimited: result.scanLimited || !sourceComplete,
          sourceComplete,
          sourceObservation: projectSourceObservation(observed),
        };
      }),
    status: async () => {
      try {
        return await dependencies.withRead(async (read) => {
          const snapshot = await capture(read);
          const observed = await snapshot.assertCurrent();
          return projectStatus(observed, snapshot.storeId, snapshot.embedding);
        });
      } catch (error) {
        if (error instanceof NativeIndexRefusalError) {
          return {
            cause: error.refusal,
            kind: 'unavailable',
            phase:
              error.refusal.kind === 'transitioning' || error.refusal.kind === 'closed'
                ? 'preparing'
                : error.refusal.kind === 'setup-required'
                  ? 'setup-required'
                  : 'blocked',
            reason: error.message,
          };
        }
        throw error;
      }
    },
  };
}
