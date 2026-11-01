import {
  createProvider,
  type ProviderAuthInput,
  resolveRuntimeConfiguration,
} from '@brainstrike/agent/provider-runtime';
import {
  type HostMemoryModels,
  hostMemoryModels,
  materializeHostProviderModel,
  type ProductionHostRunConfiguration,
} from '@brainstrike/agent-host';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import { requireMemoryApiKey } from './memory-readiness';
import type { PlatformSelectionSchema } from './platform-wire';

/** The observer model, a hosted provider's, built with that provider's credential. */
async function createObserverModel(
  target: ReturnType<typeof parseObservationalMemoryModelTarget>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>
): Promise<ReturnType<typeof materializeHostProviderModel>> {
  const auth = await requireMemoryApiKey(target.provider, resolveProviderAuth);
  const configuration = resolveRuntimeConfiguration(
    { model: target.model, provider: target.provider },
    auth
  );
  return materializeHostProviderModel(
    createProvider(configuration.provider, configuration.authInput, configuration.runtime.model)
  );
}

/** The observer's catalog `provider::model`: its usage is priced under it, like a run's own model. */
function observerCatalogModelId(
  target: ReturnType<typeof parseObservationalMemoryModelTarget>
): string {
  return `${target.provider}::${target.model}`;
}

/**
 * thread/memory/read (BST-2201): the observer an admission with this Memory
 * selection uses. Observations name an observer only once it
 * resolved; a waiting or disabled observer has none.
 */
export function desktopMemoryModels(
  memory: (typeof PlatformSelectionSchema)['Type']['memory']
): HostMemoryModels {
  const observation = memory.settings.observationalMemory;
  return hostMemoryModels(
    observation.enabled
      ? observerCatalogModelId(parseObservationalMemoryModelTarget(observation.modelTarget))
      : undefined
  );
}

/** Materialize public Memory options from the admitted, non-secret selection. */
export async function createDesktopHostMemoryConfiguration(
  selection: Pick<(typeof PlatformSelectionSchema)['Type'], 'memory' | 'resourceId'>,
  resolveProviderAuth: (provider: string) => Promise<ProviderAuthInput | undefined>
): Promise<ProductionHostRunConfiguration['memory']> {
  const { observationalMemory: observation } = selection.memory.settings;

  let observationalMemory: NonNullable<
    ProductionHostRunConfiguration['memory']['native']['options']
  >['observationalMemory'] = false;
  let observerModelId: string | undefined;
  if (observation.enabled) {
    const target = parseObservationalMemoryModelTarget(observation.modelTarget);
    observerModelId = observerCatalogModelId(target);
    observationalMemory = {
      model: await createObserverModel(target, resolveProviderAuth),
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
        workingMemory: { ...selection.memory.options.workingMemory },
      },
    },
    ...(observerModelId === undefined ? {} : { observerModelId }),
    ...(selection.memory.observerAwaiting
      ? { observerAwaiting: selection.memory.observerAwaiting }
      : {}),
    recordPrompt: async () => undefined,
    resourceId: selection.resourceId,
  };
}
