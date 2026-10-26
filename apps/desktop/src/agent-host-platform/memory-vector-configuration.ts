import {
  createEmbeddingProvider,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import type {
  HostMemoryEmbedderTarget,
  ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import {
  MEMORY_EMBEDDER_SELECTION_REMEDY,
  MEMORY_FAILURE_CODES,
  memoryConfigurationError,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { VectorProfile } from '@brainstrike/indexer';
import { Schema } from 'effect';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import { hostedMemoryEmbedderFailure } from './memory-embedder-failure';
import { requireMemoryApiKey } from './memory-readiness';
import { PlatformMemorySettingsSchema, type PlatformSelection } from './platform-wire';

type MemoryConfiguration = ProductionHostRunConfiguration['memory'];
type NativeOptions = NonNullable<MemoryConfiguration['native']['options']>;

/** A hosted embedder for the profile Main admitted, built with its provider's API key. */
function hostedMemoryEmbedder(
  profile: VectorProfile,
  apiKey: string
): NonNullable<MemoryConfiguration['vectors']> {
  const provider = profile.provider;
  return {
    // BST-2202: its failures read with the hosted embedding classification indexing uses.
    classifyFailure: (cause) => hostedMemoryEmbedderFailure(provider, cause),
    embedder: createEmbeddingProvider(provider, apiKey, profile.modelId),
    profile,
  };
}

/**
 * The run's recall embedder for the profile Main admitted, run here in Node with
 * the resolved credential. The host owns the vector store.
 */
export async function createDesktopHostMemoryVectorConfiguration(
  selection: Pick<PlatformSelection, 'memory'>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>
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
  const auth = await requireMemoryApiKey(
    semanticRecall.enabled ? 'semantic-recall' : 'semantic-observation-recall',
    profile.provider,
    resolveProviderAuth
  );
  const vectors = hostedMemoryEmbedder(profile, auth.apiKey);
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

/**
 * BST-2227: the embedder Settings → Assistant Memory tests, resolved as a run's
 * admission resolves its recall embedder: Main's catalog profile for the
 * selected target, then this host's API key for its provider. It tests the
 * selection whether or not recall is on yet.
 */
export async function resolveDesktopMemoryEmbedderProbe(
  memorySettings: unknown,
  readMemoryVectors: DesktopAdmissionReads['memoryVectors'],
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>,
  signal: AbortSignal
): Promise<HostMemoryEmbedderTarget> {
  const settings = Schema.decodeUnknownSync(PlatformMemorySettingsSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(memorySettings);
  const target = settings.semanticRecall.embeddingModelTarget?.trim();
  if (!target) {
    throw refusalError(
      'configuration',
      MEMORY_FAILURE_CODES.configuration,
      'Semantic recall has no embedding model selected.',
      MEMORY_EMBEDDER_SELECTION_REMEDY
    );
  }
  const resolved = await readMemoryVectors(
    { ...settings, semanticRecall: { ...settings.semanticRecall, enabled: true } },
    signal
  );
  if (!resolved) {
    throw memoryConfigurationError('Main resolved no embedder for a selected recall target');
  }
  const auth = await requireMemoryApiKey('semantic-recall', resolved.provider, resolveProviderAuth);
  signal.throwIfAborted();
  const { classifyFailure, embedder, profile } = hostedMemoryEmbedder(resolved, auth.apiKey);
  if (typeof embedder === 'string') {
    throw memoryConfigurationError('A hosted memory embedder must be a concrete model');
  }
  return {
    embedder,
    identity: {
      ...(classifyFailure ? { classifyFailure } : {}),
      modelId: `${profile.provider}::${profile.modelId}`,
    },
  };
}
