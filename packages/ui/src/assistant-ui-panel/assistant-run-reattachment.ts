import type { CreateResumeRunConfig, ThreadMessage } from '@assistant-ui/react';
import {
  type AssistantActiveRunSession,
  isAssistantActiveRunSession,
} from '@brainstrike/assistant-contract';
import { useEffect, useRef } from 'react';

const ACTIVE_RUN_STORAGE_PREFIX = 'brainstrike.assistant.active-run:';

function activeRunStorageKey(threadKey: string): string {
  const normalized = threadKey.trim();
  if (!normalized) {
    throw new Error('Assistant active-run storage requires a non-empty thread key.');
  }
  return `${ACTIVE_RUN_STORAGE_PREFIX}${normalized}`;
}

export function writeAssistantActiveRunSession(
  threadKey: string,
  record: AssistantActiveRunSession,
  storage: Storage = window.sessionStorage
): void {
  if (!isAssistantActiveRunSession(record)) {
    throw new Error('Assistant active-run session is malformed.');
  }
  storage.setItem(activeRunStorageKey(threadKey), JSON.stringify(record));
}

export function readAssistantActiveRunSession(
  threadKey: string,
  storage: Storage = window.sessionStorage
): AssistantActiveRunSession | undefined {
  const value = storage.getItem(activeRunStorageKey(threadKey));
  if (value === null) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('Stored assistant active-run session is malformed JSON.', { cause: error });
  }
  if (!isAssistantActiveRunSession(parsed)) {
    throw new Error('Stored assistant active-run session is malformed.');
  }
  return parsed;
}

export function clearAssistantActiveRunSession(
  threadKey: string,
  storage: Storage = window.sessionStorage
): void {
  storage.removeItem(activeRunStorageKey(threadKey));
}

interface ReattachableRuntime {
  readonly thread: {
    getState(): {
      readonly isLoading: boolean;
      readonly isRunning: boolean;
      readonly messages: readonly ThreadMessage[];
    };
    resumeRun(config: {
      parentId: string | null;
      runConfig: Record<string, unknown>;
      stream: NonNullable<CreateResumeRunConfig['stream']>;
    }): void;
    subscribe(listener: () => void): () => void;
  };
}

export function useAssistantRunReattachment({
  record,
  runtime,
  stream,
}: {
  readonly record: AssistantActiveRunSession | undefined;
  readonly runtime: ReattachableRuntime;
  readonly stream: NonNullable<CreateResumeRunConfig['stream']>;
}): void {
  const attemptedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!record) {
      attemptedEventIdRef.current = null;
      return;
    }
    const attempt = (): void => {
      const state = runtime.thread.getState();
      if (state.isLoading || state.isRunning || attemptedEventIdRef.current === record.eventId) {
        return;
      }
      attemptedEventIdRef.current = record.eventId;
      runtime.thread.resumeRun({
        parentId: state.messages.at(-1)?.id ?? null,
        runConfig: {},
        stream,
      });
    };

    attempt();
    return runtime.thread.subscribe(attempt);
  }, [record, runtime, stream]);
}
