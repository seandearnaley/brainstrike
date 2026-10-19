import {
  type BoundaryFailure,
  type BoundaryFailureCategory,
  BoundaryFailureError,
  fault,
} from './boundary-failure.js';
import { getProviderDisplayName, isSupportedProvider } from './provider-metadata.js';

/**
 * The typed memory boundary codes (BST-2202): which part of memory failed. The
 * memory step names its observer, embedder or vector store; admission names a
 * configuration it cannot run or an embedder it cannot reach.
 */
export const MEMORY_FAILURE_CODES = {
  /** Memory cannot run as configured: a missing selection or an invalid setting. */
  configuration: 'memory.configuration-invalid',
  /** A hosted memory model's provider has no API key. */
  credentialMissing: 'memory.credential-missing',
  /** The memory embedder failed to embed. */
  embedder: 'memory.embedder-failed',
  /** The on-device memory embedder has no execution device on this machine (BST-2193). */
  embedderDeviceUnavailable: 'memory.embedder-device-unavailable',
  /** The memory embedder cannot be reached or is not running. */
  embedderUnavailable: 'memory.embedder-unavailable',
  /** An observational memory observer or reflector model call failed. */
  observer: 'memory.observer-failed',
  /** The memory vector store failed to query or store vectors. */
  vectorStore: 'memory.vector-store-failed',
} as const;

/** What the user can do when the on-device memory embedder cannot run. */
export const MEMORY_ON_DEVICE_EMBEDDER_REMEDY =
  'Choose a hosted embedding model in Settings → Assistant Memory, or turn off semantic recall and vector observation retrieval.';

/**
 * What the user can do when the on-device embedder has no execution device:
 * choose one in the Assistant Memory picker (BST-2201), or not run on-device.
 */
export const MEMORY_EMBEDDER_DEVICE_REMEDY =
  'Choose a device in Settings → Assistant Memory → On-device embedding device, choose a hosted embedding model there, or turn off semantic recall and vector observation retrieval.';

/** What the user can do when memory's embedding model is not selected or not in the catalog. */
export const MEMORY_EMBEDDER_SELECTION_REMEDY =
  'Choose an embedding model in Settings → Assistant Memory.';

/** The memory part a failed call belonged to. */
export type MemoryComponent = 'observer' | 'reflector' | 'embedder' | 'vector-store';

export interface MemoryComponentFailureInput {
  readonly component: MemoryComponent;
  /**
   * A producer's model-safe classification of the failure: no keys, host paths
   * or provider body (for example a `HostedEmbeddingError` message).
   */
  readonly detail?: string;
  /** The provider's HTTP status: with the provider's name, the only evidence shown. */
  readonly httpStatus?: number;
  /** The memory model's catalog `provider::model`, or its bare model id. */
  readonly modelId?: string;
  /** The run-visible memory step, such as `recall`. */
  readonly step: string;
}

const ROLES: Readonly<Record<MemoryComponent, string>> = {
  embedder: 'embedding model',
  observer: 'observer model',
  reflector: 'reflector model',
  'vector-store': 'vector store',
};

const CODES: Readonly<Record<MemoryComponent, string>> = {
  embedder: MEMORY_FAILURE_CODES.embedder,
  observer: MEMORY_FAILURE_CODES.observer,
  reflector: MEMORY_FAILURE_CODES.observer,
  'vector-store': MEMORY_FAILURE_CODES.vectorStore,
};

/** A catalog `provider::model` names its provider; a bare model id names none. */
function modelIdentity(modelId: string): { readonly model: string; readonly provider?: string } {
  const separator = modelId.indexOf('::');
  const provider = separator === -1 ? undefined : modelId.slice(0, separator);
  return provider !== undefined && isSupportedProvider(provider)
    ? { model: modelId.slice(separator + 2), provider: getProviderDisplayName(provider) }
    : { model: modelId };
}

function categoryFor(
  component: MemoryComponent,
  httpStatus: number | undefined
): BoundaryFailureCategory {
  if (httpStatus === undefined) {
    return component === 'vector-store' ? 'internal' : 'availability';
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
  const remedy =
    component === 'vector-store'
      ? undefined
      : rejected
        ? `Check the ${providerName ?? 'provider’s'} API key in Settings → Providers, or choose another ${
            component === 'embedder' ? 'embedding model' : 'observer model'
          } in Settings → Assistant Memory.`
        : 'Retry, or review Settings → Assistant Memory.';
  return fault({
    category: categoryFor(component, httpStatus),
    code: CODES[component],
    message,
    ...(httpStatus === undefined
      ? {}
      : { providerEvidence: `${providerName ?? 'The provider'} returned HTTP ${httpStatus}.` }),
    ...(remedy === undefined ? {} : { remedy }),
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
