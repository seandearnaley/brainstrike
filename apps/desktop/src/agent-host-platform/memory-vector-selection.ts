import {
  MEMORY_EMBEDDER_SELECTION_REMEDY,
  MEMORY_FAILURE_CODES,
  refusalError,
} from '@brainstrike/assistant-contract';
import { parseSemanticRecallEmbeddingModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import { resolveNativeCanonicalProfile } from '@brainstrike/canonical-ingestion';
import type { VectorProfile } from '@brainstrike/indexer';
import type { PlatformSelection } from './platform-wire';

export interface DesktopMemoryVectorSources {
  /** A hosted model's catalog dimensions; an unknown model throws. */
  readDimensions(provider: string, modelId: string): Promise<number>;
}

/**
 * Recall and vector OM embed with the semantic recall target, which is
 * independent of Search & Indexing, as it was before host threads.
 */
export async function resolveDesktopMemoryVectors(
  settings: PlatformSelection['memory']['settings'],
  sources: DesktopMemoryVectorSources
): Promise<VectorProfile | undefined> {
  const { observationalMemory: observation, semanticRecall } = settings;
  if (
    !(semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector'))
  ) {
    return undefined;
  }
  if (!semanticRecall.embeddingModelTarget?.trim()) {
    throw refusalError(
      'configuration',
      MEMORY_FAILURE_CODES.configuration,
      'Semantic recall has no embedding model selected.',
      MEMORY_EMBEDDER_SELECTION_REMEDY
    );
  }
  const target = parseSemanticRecallEmbeddingModelTarget(semanticRecall.embeddingModelTarget);
  const modelKey = `${target.provider}::${target.model}`;
  return resolveNativeCanonicalProfile({
    dimensions: await sources.readDimensions(target.provider, target.model),
    distance: 'cosine',
    id: `memory:${modelKey}`,
    modelId: target.model,
    modelKey,
  }).profile;
}
