import {
  createProvider,
  type ProviderAuthInput,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import {
  materializeHostProviderModel,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { z } from 'zod';
import {
  createDesktopHostMemoryVectorConfiguration,
  type DesktopHostMemoryVectorCapabilities,
} from './memory-vector-configuration';
import type { PlatformSelectionSchema } from './platform-wire';

/** Materialize public Memory options from the admitted, non-secret selection. */
export async function createDesktopHostMemoryConfiguration(
  selection: z.output<typeof PlatformSelectionSchema>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>,
  vectors?: DesktopHostMemoryVectorCapabilities
): Promise<ProductionHostRunConfiguration['memory']> {
  const { observationalMemory: observation } = selection.memory.settings;
  const vectorConfiguration = createDesktopHostMemoryVectorConfiguration(selection, vectors);

  let observationalMemory: NonNullable<
    ProductionHostRunConfiguration['memory']['native']['options']
  >['observationalMemory'] = false;
  if (observation.enabled) {
    const target = parseObservationalMemoryModelTarget(observation.modelTarget);
    if (target.provider === 'local') {
      throw new Error(
        'Local Observational Memory requires the existing local LLM host capability.'
      );
    }
    const auth = await resolveProviderAuth(target.provider);
    if (auth?.kind !== 'api_key' || !auth.apiKey.trim()) {
      throw new Error(
        `Observational Memory requires the resolved ${target.provider} API credential`
      );
    }
    const configuration = resolveRuntimeConfiguration(
      { model: target.model, provider: target.provider },
      auth
    );
    observationalMemory = {
      model: materializeHostProviderModel(
        createProvider(
          configuration.provider,
          configuration.authInput,
          configuration.runtime.model,
          configuration.runtime
        )
      ),
      scope: observation.scope,
      ...(observation.retrievalMode === 'messages'
        ? { retrieval: { scope: observation.scope } }
        : observation.retrievalMode === 'vector'
          ? { retrieval: { scope: observation.scope, vector: true } }
          : {}),
      observation: { messageTokens: observation.messageTokens },
      reflection: { observationTokens: observation.observationTokens },
    };
  }

  vectors?.signal.throwIfAborted();
  return {
    native: {
      ...(vectorConfiguration.vectorBridge
        ? { embedder: vectorConfiguration.embedder, vector: vectorConfiguration.vectorBridge }
        : {}),
      options: {
        ...selection.memory.options,
        observationalMemory,
        semanticRecall: vectorConfiguration.semanticRecall,
        workingMemory: { ...selection.memory.options.workingMemory },
      },
    },
    recordPrompt: async () => undefined,
    resourceId: selection.resourceId,
    ...(vectorConfiguration.vectorBridge ? { vectorBridge: vectorConfiguration.vectorBridge } : {}),
  };
}
