import { parseSemanticRecallEmbeddingModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type {
  CatalogEmbeddingWorkerPlan,
  SelectedEmbeddingRequestPlan,
} from '@brainstrike/embeddings/inference-plan';
import type { VectorProfile } from '@brainstrike/indexer';
import { resolveNativeCanonicalProfile } from '../native-canonical-profile';
import type { PlatformSelection } from './platform-wire';

/** Main's admitted recall embedding: the wire profile, plus the local worker plan it keeps. */
export interface DesktopMemoryVectorSelection {
  /** Main-only: the exact saved local plan sent with each borrowed query. */
  readonly local?: {
    readonly modelKey: string;
    readonly workerPlan: CatalogEmbeddingWorkerPlan;
  };
  readonly profile: VectorProfile;
}

export interface DesktopMemoryVectorSources {
  /** The selected model's catalog dimensions; an unknown model throws. */
  readDimensions(provider: string, modelId: string): Promise<number>;
  /** The saved local execution selection (Search & Indexing), never a derived default. */
  readLocalSelection(): Promise<SelectedEmbeddingRequestPlan | undefined>;
}

/**
 * Recall and vector OM embed with the semantic recall target. Its profile is
 * resolved by the workspace index's own profile resolution, so memory and
 * workspace vectors follow one rule. Absent or mismatched local execution
 * settings fail visibly; nothing substitutes a model.
 */
export async function resolveDesktopMemoryVectors(
  settings: PlatformSelection['memory']['settings'],
  sources: DesktopMemoryVectorSources
): Promise<DesktopMemoryVectorSelection | undefined> {
  const { observationalMemory: observation, semanticRecall } = settings;
  if (
    !(semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector'))
  ) {
    return undefined;
  }
  if (!semanticRecall.embeddingModelTarget?.trim()) {
    throw new Error('Memory vectors require the selected semantic recall embedding model target');
  }
  const target = parseSemanticRecallEmbeddingModelTarget(semanticRecall.embeddingModelTarget);
  const modelKey = `${target.provider}::${target.model}`;
  const resolved = resolveNativeCanonicalProfile(
    {
      dimensions: await sources.readDimensions(target.provider, target.model),
      distance: 'cosine',
      id: `memory:${modelKey}`,
      modelId: target.model,
      modelKey,
    },
    target.provider === 'local' ? await sources.readLocalSelection() : undefined
  );
  return {
    profile: resolved.profile,
    ...(resolved.workerPlan ? { local: { modelKey, workerPlan: resolved.workerPlan } } : {}),
  };
}
