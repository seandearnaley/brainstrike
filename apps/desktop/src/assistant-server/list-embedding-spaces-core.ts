/**
 * The `listEmbeddingSpaces` native tool (BST-743): enumerate embedding spaces
 * from the catalog, flag the native index's Workspace Index space (recommended
 * for workspace search), and optionally attach coverage stats.
 */

import type { ListEmbeddingSetsInput } from '@brainstrike/agent';
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { EmbeddingSpaceListing, EmbeddingSpaceStats } from '@brainstrike/db';
import type {
  IndexerCoverageBatch,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { RetrievalStore } from './retrieval-store';
import { nativeWorkspaceIndexSummary, type WorkspaceIndexSummary } from './workspace-index-summary';

type AssistantEmbeddingSpaceListing = Omit<EmbeddingSpaceListing, 'stats'> & {
  readonly coverage?:
    | (EmbeddingSpaceStats & {
        readonly coveragePercent: number;
      })
    | NativeEmbeddingSpaceCoverage;
  readonly isWorkspaceIndex: boolean;
  readonly nativeSearchAuthorized?: boolean;
  readonly recommendedForWorkspaceSearch: boolean;
};

interface NativeEmbeddingSpaceCoverage {
  readonly coveragePercent: number | null;
  readonly embeddedChunks: number;
  readonly fileCount: number;
  readonly missingVectors: number;
  readonly scanComplete: boolean;
  readonly source: 'native';
  readonly totalChunks: number;
  readonly vectorCoverageComplete: boolean;
}
interface NativeListing {
  readonly coverage?: NativeEmbeddingSpaceCoverage;
  readonly coverageObservation?: {
    readonly kind: IndexerCoverageBatch['kind'];
    readonly code?: string;
  };
  readonly workspaceIndex: WorkspaceIndexSummary;
}
async function readNativeListing(
  capability: IndexSearchCapability,
  includeStats: boolean
): Promise<NativeListing> {
  const status = await capability.status();
  if (status.kind !== 'ready') {
    throw new ToolInputError(status.reason);
  }
  const workspaceIndex = nativeWorkspaceIndexSummary(status);
  const { embeddingSetId } = workspaceIndex;
  if (!includeStats || embeddingSetId === null) {
    return { workspaceIndex };
  }
  const batch = await capability.coverageBatch([{ collectionId: embeddingSetId, rootIds: [] }]);
  if (batch.kind === 'blocked') {
    throw new ToolInputError(batch.reason);
  }
  if (batch.kind === 'invalidated') {
    return { coverageObservation: { code: batch.code, kind: batch.kind }, workspaceIndex };
  }
  const coverage = batch.coverage[0];
  const collection = coverage?.collections?.[0];
  if (
    batch.coverage.length !== 1 ||
    !coverage ||
    coverage.collections?.length !== 1 ||
    collection?.embeddingSetId !== embeddingSetId ||
    coverage.storeId !== status.storeId ||
    batch.status.storeId !== status.storeId ||
    !batch.status.authorizedCollectionIds?.includes(embeddingSetId) ||
    JSON.stringify(coverage.embedding) !== JSON.stringify(status.embedding) ||
    JSON.stringify(batch.status.embedding) !== JSON.stringify(status.embedding)
  ) {
    throw new ToolInputError(
      'Native collection coverage changed authority or returned inconsistent scope.'
    );
  }
  return {
    coverage: {
      coveragePercent:
        collection.chunks > 0 ? Math.round((collection.vectors / collection.chunks) * 100) : null,
      embeddedChunks: collection.vectors,
      fileCount: collection.indexedFiles,
      missingVectors: collection.missingVectors,
      scanComplete:
        batch.status.collectionReadiness?.some(
          (row) => row.embeddingSetId === embeddingSetId && row.scanComplete
        ) === true,
      source: 'native',
      totalChunks: collection.chunks,
      vectorCoverageComplete: coverage.vectorCoverageComplete,
    },
    coverageObservation: { kind: 'current' },
    workspaceIndex,
  };
}

export async function runListEmbeddingSpacesWith(
  input: ListEmbeddingSetsInput,
  nativeIndexSearch: IndexSearchCapability | undefined,
  store: RetrievalStore
): Promise<{
  count: number;
  workspaceIndex: WorkspaceIndexSummary;
  spaces: AssistantEmbeddingSpaceListing[];
  coverageObservation?: NativeListing['coverageObservation'];
}> {
  if (!nativeIndexSearch) {
    // The agent host lists spaces against the native index only.
    throw new Error('Retrieval without a native index runs only on Main’s database.');
  }
  const native = await readNativeListing(nativeIndexSearch, input.includeStats === true);
  const { workspaceIndex } = native;
  const listings = await store.embeddingSpaces({ includeStats: input.includeStats === true });
  const mappedSpaces = listings.map((listing: EmbeddingSpaceListing) => {
    const isWorkspaceIndex = listing.id === workspaceIndex.embeddingSetId;
    const space = {
      createdAt: listing.createdAt,
      description: listing.description,
      dimensions: listing.dimensions,
      distance: listing.distance,
      id: listing.id,
      isWorkspaceIndex,
      modelId: listing.modelId,
      modelKey: listing.modelKey,
      name: listing.name,
      nativeSearchAuthorized: isWorkspaceIndex,
      recommendedForWorkspaceSearch: isWorkspaceIndex,
    };
    if (isWorkspaceIndex) {
      return native.coverage ? { ...space, coverage: native.coverage } : space;
    }
    if (input.includeStats !== true || !listing.stats) {
      return space;
    }
    const {
      embeddedChunks,
      fileCount,
      tokenizedChunkCount,
      totalChunks,
      totalTokens,
      averageTokensPerChunk,
    } = listing.stats;
    return {
      ...space,
      coverage: {
        averageTokensPerChunk,
        coveragePercent: totalChunks > 0 ? Math.round((embeddedChunks / totalChunks) * 100) : 0,
        embeddedChunks,
        fileCount,
        tokenizedChunkCount,
        totalChunks,
        totalTokens,
      },
    };
  });
  const spaces =
    input.workspaceIndexOnly === true
      ? mappedSpaces.filter((space) => space.isWorkspaceIndex)
      : mappedSpaces;
  return {
    count: spaces.length,
    spaces,
    workspaceIndex,
    ...(native.coverageObservation ? { coverageObservation: native.coverageObservation } : {}),
  };
}
