import {
  createEmbeddingProvider,
  createLocalHostMemoryEmbedder,
  type LocalEmbeddingHostClient,
  type ProviderAuthInput,
} from '@brainstrike/agent/provider-runtime';
import type {
  HostMemoryEmbedderTarget,
  ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import {
  BoundaryFailureError,
  fault,
  MEMORY_EMBEDDER_SELECTION_REMEDY,
  MEMORY_FAILURE_CODES,
  MEMORY_ON_DEVICE_EMBEDDER_REMEDY,
  memoryConfigurationError,
  refusalError,
} from '@brainstrike/assistant-contract';
import { parseSemanticRecallEmbeddingModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { VectorProfile } from '@brainstrike/indexer';
import { Schema } from 'effect';
import type { DesktopAdmissionReads } from './desktop-run-admission';
import { hostedMemoryEmbedderFailure } from './memory-embedder-failure';
import { requireMemoryApiKey } from './memory-readiness';
import { PlatformMemorySettingsSchema, type PlatformSelection } from './platform-wire';

type MemoryConfiguration = ProductionHostRunConfiguration['memory'];
type NativeOptions = NonNullable<MemoryConfiguration['native']['options']>;

type HostedVectorProfile = VectorProfile & {
  readonly provider: Exclude<VectorProfile['provider'], 'local' | 'transformers'>;
};

function isHostedVectorProfile(profile: VectorProfile): profile is HostedVectorProfile {
  return profile.provider !== 'local' && profile.provider !== 'transformers';
}

/** A hosted embedder for the profile Main admitted, built with its provider's API key. */
function hostedMemoryEmbedder(
  profile: HostedVectorProfile,
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
  if (isHostedVectorProfile(profile)) {
    const auth = await requireMemoryApiKey(
      semanticRecall.enabled ? 'semantic-recall' : 'semantic-observation-recall',
      profile.provider,
      resolveProviderAuth
    );
    vectors = hostedMemoryEmbedder(profile, auth.apiKey);
  } else {
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

/**
 * BST-2227: the embedder Settings → Assistant Memory tests, resolved as a run's
 * admission resolves its recall embedder: Main's catalog profile for the
 * selected target, then this host's API key for its provider. It tests the
 * selection whether or not recall is on yet. Only hosted embedders are tested:
 * an on-device one would load its model into the hidden embedding host.
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
  if (parseSemanticRecallEmbeddingModelTarget(target).provider === 'local') {
    throw refusalError(
      'input',
      MEMORY_FAILURE_CODES.configuration,
      'Test embedder checks hosted embedding models. An on-device model is checked when recall first uses it.'
    );
  }
  const selection = await readMemoryVectors(
    { ...settings, semanticRecall: { ...settings.semanticRecall, enabled: true } },
    signal
  );
  if (!selection) {
    throw memoryConfigurationError('Main resolved no embedder for a selected recall target');
  }
  const { profile: resolved } = selection;
  if (!isHostedVectorProfile(resolved)) {
    throw memoryConfigurationError('Main resolved an on-device profile for a hosted target');
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
