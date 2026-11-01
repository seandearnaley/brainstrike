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

/** What a memory step's failure is read against. */
export interface MemoryFailureSources {
  /** The memory part a provider call failed in, from the run's provider enclosure. */
  attribution(
    cause: unknown
  ): { readonly cause: object; readonly component: MemoryComponent } | undefined;
  /** The observer's catalog `provider::model`. */
  readonly observerModelId?: string;
}

/**
 * The typed failure of a memory step: a typed failure its producer already
 * gave it, else the memory part its provider call failed in, else
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
  const { httpStatus } = extractProviderRunError(attributed.cause);
  const modelId = sources.observerModelId;
  return memoryComponentFailure({
    component: attributed.component,
    step,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(modelId === undefined ? {} : { modelId }),
  });
}
