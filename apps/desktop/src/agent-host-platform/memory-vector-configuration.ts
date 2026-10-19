import {
  createEmbeddingProvider,
  createLocalHostMemoryEmbedder,
  type LocalEmbeddingHostClient,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import type { ProductionHostRunConfiguration } from '@brainstrike/agent-host';
import {
  BoundaryFailureError,
  fault,
  MEMORY_FAILURE_CODES,
  MEMORY_ON_DEVICE_EMBEDDER_REMEDY,
  memoryConfigurationError,
} from '@brainstrike/assistant-contract';
import { hostedMemoryEmbedderFailure } from './memory-embedder-failure';
import { requireMemoryApiKey } from './memory-readiness';
import type { PlatformSelection } from './platform-wire';

type MemoryConfiguration = ProductionHostRunConfiguration['memory'];
type NativeOptions = NonNullable<MemoryConfiguration['native']['options']>;

/**
 * The run's recall embedder for the profile Main admitted. Hosted embedders run
 * here in Node with the resolved credential; a local embedder borrows Main's
 * hidden embedding host (ADR-0007). The host owns the vector store.
 */
export async function createDesktopHostMemoryVectorConfiguration(
  selection: Pick<PlatformSelection, 'memory'>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>,
  localEmbedding: LocalEmbeddingHostClient | undefined
): Promise<
  Pick<MemoryConfiguration, 'vectors'> & {
    readonly semanticRecall: NonNullable<NativeOptions['semanticRecall']>;
  }
> {
  const { observationalMemory: observation, semanticRecall } = selection.memory.settings;
  if (
    !(semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector'))
  ) {
    return { semanticRecall: false };
  }
  const profile = selection.memory.vectorProfile;
  if (!profile) {
    throw memoryConfigurationError('Memory vectors require the embedding profile Main admitted');
  }
  let vectors: NonNullable<MemoryConfiguration['vectors']>;
  if (profile.provider === 'local' || profile.provider === 'transformers') {
    if (!localEmbedding) {
      throw new BoundaryFailureError(
        fault({
          category: 'availability',
          code: MEMORY_FAILURE_CODES.embedderUnavailable,
          message: 'The on-device memory embedder cannot be reached from the agent host.',
          remedy: MEMORY_ON_DEVICE_EMBEDDER_REMEDY,
        }),
        { cause: new Error('The admitted thread selection lends no desktop embedding host') }
      );
    }
    vectors = {
      embedder: createLocalHostMemoryEmbedder({
        client: localEmbedding,
        modelId: profile.modelId,
        resolveDimensions: async () => profile.dimensions,
      }),
      profile,
    };
  } else {
    const auth = await requireMemoryApiKey(
      semanticRecall.enabled ? 'semantic-recall' : 'semantic-observation-recall',
      profile.provider,
      resolveProviderAuth
    );
    const provider = profile.provider;
    vectors = {
      // BST-2202: its failures read with the hosted embedding classification indexing uses.
      classifyFailure: (cause) => hostedMemoryEmbedderFailure(provider, cause),
      embedder: createEmbeddingProvider(provider, auth.apiKey, profile.modelId),
      profile,
    };
  }
  return {
    semanticRecall: semanticRecall.enabled
      ? {
          messageRange: semanticRecall.messageRange,
          scope: semanticRecall.scope,
          topK: semanticRecall.topK,
        }
      : false,
    vectors,
  };
}
