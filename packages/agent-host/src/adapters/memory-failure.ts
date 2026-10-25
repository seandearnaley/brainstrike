import { isProxy } from 'node:util/types';
import { extractProviderRunError } from '@brainstrike/agent/provider-runtime';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  INTERNAL_FAULT,
  type MemoryComponent,
  memoryComponentFailure,
} from '@brainstrike/assistant-contract';

/** How many of a failure's causes are read; deeper causes stay in the log. */
const MAX_CAUSES = 32;

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * A failure and its causes, outermost first: `cause`, and the `errors` of an
 * AggregateError or an AI SDK RetryError. Only own data properties are read,
 * never accessors or proxies, so reading a cause runs no code.
 */
export function* memoryFailureCauses(value: unknown): Generator<object> {
  const seen = new Set<object>();
  const queue: unknown[] = [value];
  while (queue.length > 0 && seen.size < MAX_CAUSES) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || isProxy(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    yield current;
    queue.push(ownValue(current, 'cause'));
    const errors = ownValue(current, 'errors');
    if (Array.isArray(errors) && !isProxy(errors)) {
      queue.push(...errors);
    }
  }
}

/** A platform's model-safe reading of one of its embedder's failures (BST-2202). */
interface HostMemoryEmbedderFailure {
  /** No keys, host paths or provider body: shown to the user as is. */
  readonly detail: string;
  readonly httpStatus?: number;
}

/** The run's memory embedder, as its failures name it. */
export interface HostMemoryEmbedderIdentity {
  /** A platform's classification of a raw failure of its own embedder. */
  classifyFailure?(cause: unknown): HostMemoryEmbedderFailure | undefined;
  /** The embedder's catalog `provider::model`. */
  readonly modelId: string;
}

/** What a memory step's failure is read against. */
export interface MemoryFailureSources {
  /** The memory part a provider or vector call failed in, from the run's provider enclosure. */
  attribution(
    cause: unknown
  ): { readonly cause: object; readonly component: MemoryComponent } | undefined;
  readonly embedder?: HostMemoryEmbedderIdentity;
  /** The observer's catalog `provider::model`. */
  readonly observerModelId?: string;
}

/**
 * The typed failure of a memory step: a typed failure its producer already
 * gave it, else the memory part its provider or vector call failed in, else
 * the internal fault. Never the chat provider's classification (BST-2202).
 */
export function classifyMemoryFailure(
  step: string,
  cause: unknown,
  sources: MemoryFailureSources
): BoundaryFailure {
  for (const candidate of memoryFailureCauses(cause)) {
    if (candidate instanceof BoundaryFailureError) {
      return candidate.failure;
    }
  }
  const attributed = sources.attribution(cause);
  if (!attributed) {
    return INTERNAL_FAULT;
  }
  const { component } = attributed;
  if (component === 'vector-store') {
    return memoryComponentFailure({ component, step });
  }
  const embedder = component === 'embedder' ? sources.embedder : undefined;
  const classified = embedder?.classifyFailure?.(attributed.cause);
  const httpStatus = classified
    ? classified.httpStatus
    : extractProviderRunError(attributed.cause).httpStatus;
  const modelId = component === 'embedder' ? embedder?.modelId : sources.observerModelId;
  return memoryComponentFailure({
    component,
    step,
    ...(classified ? { detail: classified.detail } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(modelId === undefined ? {} : { modelId }),
  });
}
