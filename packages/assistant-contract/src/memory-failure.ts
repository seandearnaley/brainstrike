import {
  type BoundaryFailure,
  type BoundaryFailureCategory,
  BoundaryFailureError,
  fault,
} from './boundary-failure.ts';
import { getProviderDisplayName, isSupportedProvider } from './provider-metadata.ts';

/**
 * The typed memory boundary codes (BST-2202): which part of memory failed. The
 * memory step names its observer; admission names a configuration it cannot
 * run or a credential it lacks.
 */
export const MEMORY_FAILURE_CODES = {
  /** Memory cannot run as configured: a missing selection or an invalid setting. */
  configuration: 'memory.configuration-invalid',
  /** A hosted memory model's provider has no API key. */
  credentialMissing: 'memory.credential-missing',
  /** An observational memory observer or reflector model call failed. */
  observer: 'memory.observer-failed',
} as const;

/** The memory part a failed call belonged to. */
export type MemoryComponent = 'observer' | 'reflector';

export interface MemoryComponentFailureInput {
  readonly component: MemoryComponent;
  /**
   * A producer's model-safe classification of the failure: no keys, host paths
   * or provider body.
   */
  readonly detail?: string;
  /** The provider's HTTP status: with the provider's name, the only evidence shown. */
  readonly httpStatus?: number;
  /** The memory model's catalog `provider::model`, or its bare model id. */
  readonly modelId?: string;
  /** The run-visible memory step, such as `observe`. */
  readonly step: string;
}

const ROLES: Readonly<Record<MemoryComponent, string>> = {
  observer: 'observer model',
  reflector: 'reflector model',
};

/** A catalog `provider::model` names its provider; a bare model id names none. */
function modelIdentity(modelId: string): { readonly model: string; readonly provider?: string } {
  const separator = modelId.indexOf('::');
  const provider = separator === -1 ? undefined : modelId.slice(0, separator);
  return provider !== undefined && isSupportedProvider(provider)
    ? { model: modelId.slice(separator + 2), provider: getProviderDisplayName(provider) }
    : { model: modelId };
}

function categoryFor(httpStatus: number | undefined): BoundaryFailureCategory {
  if (httpStatus === undefined) {
    return 'availability';
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return 'authorization';
  }
  if (httpStatus === 429 || httpStatus >= 500) {
    return 'availability';
  }
  return 'configuration';
}

/**
 * A memory part's failed call, as a fault: its cause stays in the sender's log
 * under the correlation id the boundary assigns. The message names the memory
 * model and its own provider, never the run's chat provider.
 */
export function memoryComponentFailure(input: MemoryComponentFailureInput): BoundaryFailure {
  const { component, detail, httpStatus, modelId, step } = input;
  const identity = modelId === undefined ? undefined : modelIdentity(modelId);
  const named =
    identity === undefined
      ? ''
      : ` (${identity.provider === undefined ? '' : `${identity.provider} `}${identity.model})`;
  const role = ROLES[component];
  const message = `Memory ${step} failed because its ${role}${named} failed${
    detail === undefined ? '.' : `: ${detail}`
  }`;
  const providerName = identity?.provider;
  const rejected = httpStatus === 401 || httpStatus === 403;
  const remedy = rejected
    ? `Check the ${providerName ?? 'provider’s'} API key in Settings → Providers, or choose another observer model in Settings → Assistant Memory.`
    : 'Retry, or review Settings → Assistant Memory.';
  return fault({
    category: categoryFor(httpStatus),
    code: MEMORY_FAILURE_CODES.observer,
    message,
    ...(httpStatus === undefined
      ? {}
      : { providerEvidence: `${providerName ?? 'The provider'} returned HTTP ${httpStatus}.` }),
    remedy,
  });
}

/** Memory's configuration cannot run; its reason stays in the log under the correlation id. */
export function memoryConfigurationFault(): BoundaryFailure {
  return fault({
    category: 'configuration',
    code: MEMORY_FAILURE_CODES.configuration,
    message: 'Memory cannot run with this configuration.',
    remedy: 'Review Settings → Assistant Memory, then retry.',
  });
}

/**
 * The configuration fault, ready to throw: `reason` is the composition's own
 * diagnostic, kept as the cause the boundary logs under its correlation id.
 */
export function memoryConfigurationError(reason: string): BoundaryFailureError {
  return new BoundaryFailureError(memoryConfigurationFault(), { cause: new Error(reason) });
}
