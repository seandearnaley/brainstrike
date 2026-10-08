import { type ProductionHostRunConfiguration, StateStoreHostMemory } from '@brainstrike/agent-host';
import { parseSemanticRecallEmbeddingModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import {
  type StateMessageScope,
  type StateMessageVectorPort,
  type VectorProfile,
  vectorProfileHash,
} from '@brainstrike/indexer';
import type { PlatformSelection } from './platform-wire';

type MemoryConfiguration = ProductionHostRunConfiguration['memory'];
type NativeOptions = NonNullable<MemoryConfiguration['native']['options']>;

/** Borrowed run capabilities; acquisition, inference and lifecycle stay with Root. */
export interface DesktopHostMemoryVectorCapabilities {
  readonly embedder: Exclude<NonNullable<MemoryConfiguration['native']['embedder']>, string>;
  readonly port: StateMessageVectorPort;
  readonly profile: VectorProfile;
  readonly scope: StateMessageScope;
  readonly signal: AbortSignal;
}

export function createDesktopHostMemoryVectorConfiguration(
  selection: PlatformSelection,
  vectors?: DesktopHostMemoryVectorCapabilities
): Pick<MemoryConfiguration, 'vectorBridge'> & {
  readonly embedder?: DesktopHostMemoryVectorCapabilities['embedder'];
  readonly semanticRecall: NonNullable<NativeOptions['semanticRecall']>;
} {
  const { observationalMemory: observation, semanticRecall } = selection.memory.settings;
  const observationVectors = observation.enabled && observation.retrievalMode === 'vector';
  if (!(semanticRecall.enabled || observationVectors)) {
    return { semanticRecall: false };
  }
  if (
    !vectors?.port ||
    typeof vectors.port.prepareStateMessageVectors !== 'function' ||
    typeof vectors.port.upsertStateMessageVectors !== 'function' ||
    typeof vectors.port.queryStateMessageVectors !== 'function' ||
    typeof vectors.port.purgeStateMessageVectors !== 'function' ||
    !vectors.embedder ||
    typeof vectors.embedder !== 'object' ||
    typeof vectors.embedder.doEmbed !== 'function' ||
    !vectors.signal
  ) {
    throw new Error(
      'This Root is missing the canonical Memory vector capability; requested settings preserved.'
    );
  }
  vectors.signal.throwIfAborted();
  if (
    vectors.scope.resourceId !== selection.resourceId ||
    !vectors.scope.rootId.trim() ||
    !vectors.scope.threadId.trim()
  ) {
    throw new Error('Memory vector capability does not match the admitted resource/scope');
  }
  if (!semanticRecall.embeddingModelTarget?.trim()) {
    throw new Error('Memory vectors require the selected semantic recall embedding model target');
  }
  const target = parseSemanticRecallEmbeddingModelTarget(semanticRecall.embeddingModelTarget);
  vectorProfileHash(vectors.profile);
  const local = vectors.profile.provider === 'local' || vectors.profile.provider === 'transformers';
  if (
    vectors.profile.distance !== 'cosine' ||
    (local && !(vectors.profile.revision && vectors.profile.dtype && vectors.profile.tokenCap))
  ) {
    throw new Error('Memory vectors require the complete acquired cosine profile');
  }
  if (
    target.provider !== (local ? 'local' : vectors.profile.provider) ||
    target.model !== vectors.profile.modelId ||
    vectors.embedder.modelId !== vectors.profile.modelId
  ) {
    throw new Error('Memory vector capability differs from the admitted embedding model target');
  }
  if (observationVectors) {
    // Memory 1.32.1 indexObservation uses observation-group IDs, not committed
    // message IDs. Root must supply their canonical authority before activation.
    // https://github.com/mastra-ai/mastra/tree/main/packages/memory
    throw new Error(
      'Observational vector retrieval requires canonical observation-group authority; the borrowed message vector capability is insufficient.'
    );
  }
  return {
    embedder: vectors.embedder,
    semanticRecall: semanticRecall.enabled
      ? {
          messageRange: semanticRecall.messageRange,
          scope: semanticRecall.scope,
          topK: semanticRecall.topK,
        }
      : false,
    vectorBridge: StateStoreHostMemory.createVectorBridge({
      port: vectors.port,
      profile: vectors.profile,
      scope: vectors.scope,
      signal: vectors.signal,
    }),
  };
}
