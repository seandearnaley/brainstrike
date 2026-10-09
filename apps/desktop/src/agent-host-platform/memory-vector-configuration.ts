import {
  createEmbeddingProvider,
  createLocalHostMemoryEmbedder,
  type LocalEmbeddingHostClient,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import type { ProductionHostRunConfiguration } from '@brainstrike/agent-host';
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
  selection: PlatformSelection,
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
    throw new Error('Memory vectors require the embedding profile Main admitted');
  }
  let embedder: NonNullable<MemoryConfiguration['vectors']>['embedder'];
  if (profile.provider === 'local' || profile.provider === 'transformers') {
    if (!localEmbedding) {
      throw new Error(
        'Local semantic recall requires the desktop embedding host, which this host cannot reach.'
      );
    }
    embedder = createLocalHostMemoryEmbedder({
      client: localEmbedding,
      modelId: profile.modelId,
      resolveDimensions: async () => profile.dimensions,
    });
  } else {
    const auth = await requireMemoryApiKey(
      semanticRecall.enabled ? 'semantic-recall' : 'semantic-observation-recall',
      profile.provider,
      resolveProviderAuth
    );
    embedder = createEmbeddingProvider(profile.provider, auth.apiKey, profile.modelId);
  }
  return {
    semanticRecall: semanticRecall.enabled
      ? {
          messageRange: semanticRecall.messageRange,
          scope: semanticRecall.scope,
          topK: semanticRecall.topK,
        }
      : false,
    vectors: { embedder, profile },
  };
}
