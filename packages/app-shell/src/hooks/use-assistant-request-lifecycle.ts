import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useCallback, useEffect, useRef } from 'react';
import {
  type AssistantForegroundActivityLease,
  acquireAssistantForegroundActivity,
} from '../assistant-foreground-activity';
import type { AssistantThreadRepository } from '../assistant-memory-repository';
import {
  createAssistantThreadRunPromise,
  extractPreparedRunId,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantRequestLifecycleArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly memoryResourceId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  readonly providerOptions: Record<string, unknown> | undefined;
  readonly requestData: Record<string, unknown>;
  readonly resolvedModelName: string | undefined;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedProvider: SupportedProvider | null;
}

interface UseAssistantRequestLifecycleResult {
  readonly completePreparedRequest: (
    preparedRequestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void>;
  readonly prepareRequestData: () => Promise<Record<string, unknown>>;
  readonly renewActiveAssistantForegroundActivity: () => void;
}

export function useAssistantRequestLifecycle({
  assistantThreadRepository,
  memoryResourceId,
  modelSettings,
  providerOptions,
  requestData,
  resolvedModelName,
  selectedMemoryThreadId,
  selectedProvider,
}: UseAssistantRequestLifecycleArgs): UseAssistantRequestLifecycleResult {
  const assistantForegroundActivityLeaseByRunIdRef = useRef(
    new Map<string, AssistantForegroundActivityLease>()
  );
  // The run currently streaming (runs are serialized per panel). Stream activity
  // renews only this run's lease, so unrelated active runs cannot keep leaked
  // sibling leases alive indefinitely.
  const activeAssistantForegroundRunIdRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      for (const lease of assistantForegroundActivityLeaseByRunIdRef.current.values()) {
        lease.release();
      }
      assistantForegroundActivityLeaseByRunIdRef.current.clear();
      activeAssistantForegroundRunIdRef.current = null;
    },
    []
  );

  const renewActiveAssistantForegroundActivity = useCallback(() => {
    const runId = activeAssistantForegroundRunIdRef.current;
    if (!runId) {
      return;
    }
    assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.renew();
  }, []);

  const prepareRequestData = useCallback(async (): Promise<Record<string, unknown>> => {
    const runId = await createAssistantThreadRunPromise({
      assistantThreadRepository,
      memoryResourceId,
      modelSettings,
      providerOptions,
      resolvedModelName,
      selectedMemoryThreadId,
      selectedProvider,
    });
    const memoryContext = requestData['memory'];
    if (!(memoryContext && typeof memoryContext === 'object' && !Array.isArray(memoryContext))) {
      throw new Error('Assistant request preparation requires Mastra memory context.');
    }
    if (runId) {
      assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.release();
      assistantForegroundActivityLeaseByRunIdRef.current.set(
        runId,
        acquireAssistantForegroundActivity({
          onExpired: () => {
            assistantForegroundActivityLeaseByRunIdRef.current.delete(runId);
            if (activeAssistantForegroundRunIdRef.current === runId) {
              activeAssistantForegroundRunIdRef.current = null;
            }
          },
        })
      );
      activeAssistantForegroundRunIdRef.current = runId;
    }

    return {
      ...requestData,
      memory: {
        ...memoryContext,
        ...(runId ? { runId } : {}),
      },
    };
  }, [
    assistantThreadRepository,
    memoryResourceId,
    modelSettings,
    providerOptions,
    requestData,
    resolvedModelName,
    selectedMemoryThreadId,
    selectedProvider,
  ]);

  const completePreparedRequest = useCallback(
    async (
      preparedRequestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ): Promise<void> => {
      const runId = extractPreparedRunId(preparedRequestData);
      if (!runId) {
        return;
      }
      if (!assistantThreadRepository) {
        throw new Error('Assistant run completion requires an active thread repository.');
      }
      try {
        await assistantThreadRepository.completeThreadRun(runId, {
          status,
          ...(error ? { error } : {}),
        });
      } finally {
        assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.release();
        assistantForegroundActivityLeaseByRunIdRef.current.delete(runId);
        if (activeAssistantForegroundRunIdRef.current === runId) {
          activeAssistantForegroundRunIdRef.current = null;
        }
      }
    },
    [assistantThreadRepository]
  );

  return {
    completePreparedRequest,
    prepareRequestData,
    renewActiveAssistantForegroundActivity,
  };
}
