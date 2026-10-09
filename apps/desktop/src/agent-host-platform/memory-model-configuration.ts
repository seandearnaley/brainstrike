import {
  createProvider,
  type LocalEmbeddingHostClient,
  type LocalLlmHostClient,
  type ProviderAuthInput,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import {
  materializeHostProviderModel,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { z } from 'zod';
import { requireMemoryApiKey } from './memory-readiness';
import { createDesktopHostMemoryVectorConfiguration } from './memory-vector-configuration';
import type { PlatformSelectionSchema } from './platform-wire';

/** ADR-0007: Main's hidden embedding and llm hosts, borrowed for one admitted thread. */
export interface DesktopHostLocalInference {
  readonly embedding: LocalEmbeddingHostClient;
  readonly llm: LocalLlmHostClient;
  readonly signal: AbortSignal;
}

/** The observer model: hosted providers resolve here; local borrows Main's llm-host. */
async function createObserverModel(
  target: ReturnType<typeof parseObservationalMemoryModelTarget>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>,
  local: DesktopHostLocalInference | undefined
): Promise<ReturnType<typeof materializeHostProviderModel>> {
  if (target.provider === 'local') {
    if (!local) {
      throw new Error(
        'Local Observational Memory requires the desktop local LLM host, which this host cannot reach.'
      );
    }
    // Cold model loads exceed one generation's ceiling; warm the observer before
    // the run, as the legacy runtime did.
    await local.llm.warmup(target.model, { signal: local.signal });
    return materializeHostProviderModel(
      createProvider('local', undefined, target.model, { localLlmHostClient: local.llm })
    );
  }
  const auth = await requireMemoryApiKey(
    'observational-memory',
    target.provider,
    resolveProviderAuth
  );
  const configuration = resolveRuntimeConfiguration(
    { model: target.model, provider: target.provider },
    auth
  );
  return materializeHostProviderModel(
    createProvider(
      configuration.provider,
      configuration.authInput,
      configuration.runtime.model,
      configuration.runtime
    )
  );
}

/** Materialize public Memory options from the admitted, non-secret selection. */
export async function createDesktopHostMemoryConfiguration(
  selection: z.output<typeof PlatformSelectionSchema>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>,
  local?: DesktopHostLocalInference
): Promise<ProductionHostRunConfiguration['memory']> {
  const { observationalMemory: observation } = selection.memory.settings;
  const vectorConfiguration = await createDesktopHostMemoryVectorConfiguration(
    selection,
    resolveProviderAuth,
    local?.embedding
  );

  let observationalMemory: NonNullable<
    ProductionHostRunConfiguration['memory']['native']['options']
  >['observationalMemory'] = false;
  let observerModelId: string | undefined;
  if (observation.enabled) {
    const target = parseObservationalMemoryModelTarget(observation.modelTarget);
    // The catalog id its usage is priced under, like a run's own model.
    observerModelId = `${target.provider}::${target.model}`;
    observationalMemory = {
      model: await createObserverModel(target, resolveProviderAuth, local),
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

  local?.signal.throwIfAborted();
  return {
    native: {
      options: {
        ...selection.memory.options,
        observationalMemory,
        semanticRecall: vectorConfiguration.semanticRecall,
        workingMemory: { ...selection.memory.options.workingMemory },
      },
    },
    ...(observerModelId === undefined ? {} : { observerModelId }),
    ...(selection.memory.observerAwaiting
      ? { observerAwaiting: selection.memory.observerAwaiting }
      : {}),
    recordPrompt: async () => undefined,
    resourceId: selection.resourceId,
    ...(vectorConfiguration.vectors ? { vectors: vectorConfiguration.vectors } : {}),
  };
}
