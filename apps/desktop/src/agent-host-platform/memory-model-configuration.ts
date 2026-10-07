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
import type { PlatformSelectionSchema } from './platform-wire';

/** Materialize public Memory options from the admitted, non-secret selection. */
export async function createDesktopHostMemoryConfiguration(
  selection: z.output<typeof PlatformSelectionSchema>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>
): Promise<ProductionHostRunConfiguration['memory']> {
  const { observationalMemory: observation, semanticRecall } = selection.memory.settings;
  if (semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector')) {
    throw new Error(
      'This Root is missing the canonical Memory vector capability; requested settings preserved.'
    );
  }

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
        : {}),
      observation: { messageTokens: observation.messageTokens },
      reflection: { observationTokens: observation.observationTokens },
    };
  }

  return {
    native: {
      options: {
        ...selection.memory.options,
        observationalMemory,
        semanticRecall: false,
        workingMemory: { ...selection.memory.options.workingMemory },
      },
    },
    recordPrompt: async () => undefined,
    resourceId: selection.resourceId,
  };
}
