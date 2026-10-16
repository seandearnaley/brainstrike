import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostMemoryPreconditions, HostObservationSource } from '@brainstrike/agent-host';
import {
  isSupportedProvider,
  type MemoryCredentialNeed,
  memoryCredentialRequiredReason,
} from '@brainstrike/assistant-contract';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import { ProviderCredentialMissingError } from '@brainstrike/host-capabilities';
import type { PlatformSelection } from './platform-wire';

type ResolveProviderAuth = (provider: string) => Promise<ProviderAuthInput | undefined>;

/** Why the memory feature cannot run without its provider's API key, as legacy words it. */
function memoryKeyRequired(need: MemoryCredentialNeed, provider: string): Error {
  return new Error(
    isSupportedProvider(provider)
      ? memoryCredentialRequiredReason(need, provider)
      : `Memory uses the unsupported provider ${provider}`
  );
}

/**
 * A hosted memory model runs here in Node with its provider's resolved API key.
 * A missing key is named for the feature that needs it; any other resolution
 * failure (a store read, an expired login) keeps its own reason.
 */
export async function requireMemoryApiKey(
  need: MemoryCredentialNeed,
  provider: string,
  resolveProviderAuth: ResolveProviderAuth
): Promise<Extract<ProviderAuthInput, { kind: 'api_key' }>> {
  let auth: ProviderAuthInput | undefined;
  try {
    auth = await resolveProviderAuth(provider);
  } catch (cause) {
    if (cause instanceof ProviderCredentialMissingError) {
      throw memoryKeyRequired(need, provider);
    }
    throw cause;
  }
  if (auth?.kind !== 'api_key' || !auth.apiKey.trim()) {
    throw memoryKeyRequired(need, provider);
  }
  return auth;
}

/** The hosted providers an admitted Memory selection resolves keys for, as its run does. */
function memoryCredentialRequirements(
  memory: PlatformSelection['memory']
): readonly { readonly need: MemoryCredentialNeed; readonly provider: string }[] {
  const { observationalMemory: observation, semanticRecall } = memory.settings;
  const requirements: { need: MemoryCredentialNeed; provider: string }[] = [];
  if (observation.enabled) {
    const target = parseObservationalMemoryModelTarget(observation.modelTarget);
    requirements.push({ need: 'observational-memory', provider: target.provider });
  }
  const profile = memory.vectorProfile;
  const vectors =
    semanticRecall.enabled || (observation.enabled && observation.retrievalMode === 'vector');
  if (vectors && profile && profile.provider !== 'local' && profile.provider !== 'transformers') {
    requirements.push({
      need: semanticRecall.enabled ? 'semantic-recall' : 'semantic-observation-recall',
      provider: profile.provider,
    });
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
    for (const { need, provider } of memoryCredentialRequirements(admitted.memory)) {
      await requireMemoryApiKey(need, provider, resolveProviderAuth);
    }
  } catch (cause) {
    return { ready: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  return { observation: observationSource(admitted.memory, admitted.resourceId), ready: true };
}
