import {
  createProvider,
  type LocalEmbeddingHostClient,
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

/** ADR-0007: Main's hidden embedding host, borrowed for one admitted thread. */
export interface DesktopHostLocalInference {
  readonly embedding: LocalEmbeddingHostClient;
  readonly signal: AbortSignal;
}

/**
 * The observer model. Every observer is a hosted provider now: the branch that
 * borrowed Main's llm-host for a `local` target went with the built-in local
 * chat model, and an observer target naming that provider refuses in
 * `requireMemoryApiKey`/`createProvider` rather than resolving to nothing.
 */
async function createObserverModel(
  target: ReturnType<typeof parseObservationalMemoryModelTarget>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>
): Promise<ReturnType<typeof materializeHostProviderModel>> {
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
  selection: Pick<z.output<typeof PlatformSelectionSchema>, 'memory' | 'resourceId'>,
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
      model: await createObserverModel(target, resolveProviderAuth),
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
