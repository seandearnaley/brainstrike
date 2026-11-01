import type { ProviderAuthInput } from '@brainstrike/agent/provider-runtime';
import type { HostMemoryPreconditions, HostObservationSource } from '@brainstrike/agent-host';
import { toBoundaryFailure } from '@brainstrike/agent-host/boundary-wire';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
  isSupportedProvider,
  MEMORY_FAILURE_CODES,
  memoryCredentialRequiredReason,
  refusalError,
} from '@brainstrike/assistant-contract';
import { parseObservationalMemoryModelTarget } from '@brainstrike/assistant-service/memory-model-targets';
import { ProviderCredentialMissingError } from '@brainstrike/host-capabilities';
import { createLogger } from '@brainstrike/logging';
import type { PlatformSelection } from './platform-wire';

type ResolveProviderAuth = (provider: string) => Promise<ProviderAuthInput | undefined>;

const logger = createLogger('DesktopMemoryReadiness');

/** Why the memory feature cannot run without its provider's API key, as legacy words it. */
function memoryKeyRequired(provider: string): BoundaryFailureError {
  return isSupportedProvider(provider)
    ? refusalError(
        'configuration',
        MEMORY_FAILURE_CODES.credentialMissing,
        memoryCredentialRequiredReason(provider)
      )
    : refusalError(
        'configuration',
        MEMORY_FAILURE_CODES.configuration,
        `Memory uses the unsupported provider ${provider}`
      );
}

/**
 * The send gate's words for a precondition failure (BST-2202): a typed
 * failure as the boundary describes it, naming a fault's correlation id. A
 * fault that arrived with one was logged by its sender (Main); one raised
 * here is logged here under a new one. Any other failure keeps its own reason.
 */
export function memoryReadinessReason(cause: unknown): string {
  if (!(cause instanceof BoundaryFailureError)) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  return describeBoundaryFailure(
    cause.failure.correlationId === undefined
      ? toBoundaryFailure(cause, (message, fields) => logger.error(message, fields))
      : cause.failure
  );
}

/**
 * The observer model runs here in Node with its provider's resolved API key.
 * A missing key is named as such; any other resolution failure (a store read,
 * an expired login) keeps its own reason.
 */
export async function requireMemoryApiKey(
  provider: string,
  resolveProviderAuth: ResolveProviderAuth
): Promise<Extract<ProviderAuthInput, { kind: 'api_key' }>> {
  let auth: ProviderAuthInput | undefined;
  try {
    auth = await resolveProviderAuth(provider);
  } catch (cause) {
    if (cause instanceof ProviderCredentialMissingError) {
      throw memoryKeyRequired(provider);
    }
    throw cause;
  }
  if (auth?.kind !== 'api_key' || !auth.apiKey.trim()) {
    throw memoryKeyRequired(provider);
  }
  return auth;
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
  const observation = admitted.memory.settings.observationalMemory;
  try {
    if (observation.enabled) {
      await requireMemoryApiKey(
        parseObservationalMemoryModelTarget(observation.modelTarget).provider,
        resolveProviderAuth
      );
    }
  } catch (cause) {
    return { ready: false, reason: memoryReadinessReason(cause) };
  }
  return { observation: observationSource(admitted.memory, admitted.resourceId), ready: true };
}
