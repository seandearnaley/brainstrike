import type { AssistantRunEvent } from '@brainstrike/assistant-contract';
import type { RuntimeAssistantMemoryScope } from '@brainstrike/assistant-contract/memory-settings';
import { useEffect, useState } from 'react';

export const ASSISTANT_MEMORY_INVALIDATED_EVENT = 'brainstrike:assistant-memory-invalidated';

const OBSERVATIONAL_MEMORY_WRITE_LABELS = new Set([
  'Observations updated',
  'Buffered observations updated',
  'Buffered observations activated',
]);

export type AssistantMemoryInvalidationDetail =
  | {
      readonly kind: 'all';
      readonly reason: string;
    }
  | {
      readonly kind: 'observational-memory';
      readonly lookupKey: string;
      readonly resourceId?: string | undefined;
      readonly threadId?: string | undefined;
    }
  | {
      readonly kind: 'usage';
      readonly resourceId: string;
      readonly runId?: string | undefined;
      readonly threadId?: string | undefined;
    };

function isAssistantMemoryInvalidationDetail(
  value: unknown
): value is AssistantMemoryInvalidationDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const detail = value as Record<string, unknown>;
  switch (detail['kind']) {
    case 'all':
      return typeof detail['reason'] === 'string' && detail['reason'].length > 0;
    case 'observational-memory':
      return typeof detail['lookupKey'] === 'string' && detail['lookupKey'].length > 0;
    case 'usage':
      return typeof detail['resourceId'] === 'string' && detail['resourceId'].length > 0;
    default:
      return false;
  }
}

export function dispatchAssistantMemoryInvalidated(
  detail: AssistantMemoryInvalidationDetail
): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(ASSISTANT_MEMORY_INVALIDATED_EVENT, { detail }));
}

export function useAssistantMemoryInvalidationToken(
  matches: (detail: AssistantMemoryInvalidationDetail) => boolean
): number {
  const [token, setToken] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const onInvalidated = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (isAssistantMemoryInvalidationDetail(detail) && matches(detail)) {
        setToken((current) => current + 1);
      }
    };
    window.addEventListener(ASSISTANT_MEMORY_INVALIDATED_EVENT, onInvalidated);
    return () => {
      window.removeEventListener(ASSISTANT_MEMORY_INVALIDATED_EVENT, onInvalidated);
    };
  }, [matches]);

  return token;
}

export function isObservationalMemoryWriteRunEvent(event: AssistantRunEvent): boolean {
  return (
    event.kind === 'memory.observation.completed' &&
    event.status === 'completed' &&
    OBSERVATIONAL_MEMORY_WRITE_LABELS.has(event.label)
  );
}

function buildInvalidationObservationalMemoryLookupKey(input: {
  readonly resourceId: string | undefined;
  readonly scope: RuntimeAssistantMemoryScope;
  readonly threadId: string | undefined;
}): string | null {
  if (input.scope === 'resource') {
    return input.resourceId ? `resource:${input.resourceId}` : null;
  }
  return input.threadId ? `thread:${input.threadId}` : null;
}

export function dispatchObservationalMemoryInvalidatedForActiveScope(input: {
  readonly resourceId: string | undefined;
  readonly scope: RuntimeAssistantMemoryScope;
  readonly threadId: string | undefined;
}): void {
  const lookupKey = buildInvalidationObservationalMemoryLookupKey(input);
  if (!lookupKey) {
    return;
  }
  dispatchAssistantMemoryInvalidated({
    kind: 'observational-memory',
    lookupKey,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}
