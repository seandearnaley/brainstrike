import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostMemoryPreconditions, HostObservationSource } from '@brainstrike/agent-host';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import type { PlatformSelection } from './platform-wire';

type ResolveProviderAuth = (provider: string) => Promise<ProviderAuthInput | undefined>;
type MemoryFeature = 'Observational Memory' | 'Semantic recall';

/** A hosted memory model runs here in Node with its provider's resolved API key. */
export async function requireMemoryApiKey(
  feature: MemoryFeature,
  provider: string,
  resolveProviderAuth: ResolveProviderAuth
): Promise<Extract<ProviderAuthInput, { kind: 'api_key' }>> {
  const auth = await resolveProviderAuth(provider);
  if (auth?.kind !== 'api_key' || !auth.apiKey.trim()) {
    throw new Error(`${feature} requires the resolved ${provider} API credential`);
  }
  return auth;
}

/** The hosted providers an admitted Memory selection resolves keys for, as its run does. */
function memoryCredentialRequirements(
  memory: PlatformSelection['memory']
): readonly { readonly feature: MemoryFeature; readonly provider: string }[] {
  const { observationalMemory: observation, semanticRecall } = memory.settings;
  const requirements: { feature: MemoryFeature; provider: string }[] = [];
  if (observation.enabled) {
    const target = parseObservationalMemoryModelTarget(observation.modelTarget);
    if (target.provider !== 'local') {
      requirements.push({ feature: 'Observational Memory', provider: target.provider });
    }
  }
  const profile = memory.vectorProfile;
  const vectors =
    semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector');
  if (vectors && profile && profile.provider !== 'local' && profile.provider !== 'transformers') {
    requirements.push({ feature: 'Semantic recall', provider: profile.provider });
  }
  return requirements;
}

function observationSource(
  memory: PlatformSelection['memory'],
  resourceId: string
): HostObservationSource {
  const observation = memory.settings.observationalMemory;
  if (observation.enabled) {
    return { resourceId, scope: observation.scope, state: 'on' };
  }
  return memory.observerAwaiting
    ? { reason: memory.observerAwaiting, state: 'awaiting-observer' }
    : { state: 'off' };
}

/**
 * thread/memory/read in Node: Main's preconditions passed, so check the memory
 * credentials the run would resolve, with no model built or warmed.
 */
export async function desktopMemoryPreconditions(
  admitted: { readonly memory: PlatformSelection['memory']; readonly resourceId: string },
  resolveProviderAuth: ResolveProviderAuth
): Promise<HostMemoryPreconditions> {
  try {
    for (const { feature, provider } of memoryCredentialRequirements(admitted.memory)) {
      await requireMemoryApiKey(feature, provider, resolveProviderAuth);
    }
  } catch (cause) {
    return { ready: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  return { observation: observationSource(admitted.memory, admitted.resourceId), ready: true };
}
