import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
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
  /**
   * The focused workspace ROOT id at request preparation, or null/undefined
   * when no root is focused. Snapshotted with the run so durable usage is
   * attributed to the root the run operated on — focus, like the model, can
   * change mid-run.
   */
  readonly focusedRootId: string | null | undefined;
  readonly memoryResourceId: string | undefined;
  readonly modelSettings: RuntimeData['modelSettings'] | undefined;
  /**
   * Whether plan mode is offered at all for the current transport/provider
   * (mirrors the caller's `planModeAvailable` gate — never offered for the
   * built-in local provider). Combined at request-composition time with a
   * FRESH read of the persisted toggle (see `prepareRequestData` below) so the
   * gate itself never goes stale mid-request.
   */
  readonly planModeAvailable: boolean;
  readonly providerOptions: Record<string, unknown> | undefined;
  readonly requestData: Record<string, unknown>;
  readonly resolvedModelName: string | undefined;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedProvider: SupportedProvider | null;
}

/**
 * The model/provider that PRODUCED a run's tokens, snapshotted at request start.
 * The model picker stays interactive during a run, so usage must be attributed
 * to this snapshot — not the live picker selection when the finish event fires.
 */
export interface AssistantRunUsageContext {
  readonly model: string;
  readonly provider: string;
  /**
   * Focused workspace ROOT id at request start, or null when unattributed.
   * Snapshotted (not read live at finish) for the same reason as the model.
   */
  readonly rootId: string | null;
  readonly runId: string;
}

interface UseAssistantRequestLifecycleResult {
  readonly completePreparedRequest: (
    preparedRequestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void>;
  /**
   * The active run's request-start usage context, or null when no run is in
   * flight. Reads from a ref so the usage callback attributes durable rows to
   * the model that produced the tokens, not the current picker selection.
   */
  readonly getActiveRunUsageContext: () => AssistantRunUsageContext | null;
  readonly prepareRequestData: () => Promise<Record<string, unknown>>;
  readonly renewActiveAssistantForegroundActivity: () => void;
}

export function useAssistantRequestLifecycle({
  assistantThreadRepository,
  focusedRootId,
  memoryResourceId,
  modelSettings,
  planModeAvailable,
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
  // Request-start {provider, model} snapshot per run id. The picker stays
  // interactive mid-run, so usage attribution must read this snapshot, not the
  // live selection at finish time.
  const runUsageContextByRunIdRef = useRef(new Map<string, AssistantRunUsageContext>());

  useEffect(
    () => () => {
      for (const lease of assistantForegroundActivityLeaseByRunIdRef.current.values()) {
        lease.release();
      }
      assistantForegroundActivityLeaseByRunIdRef.current.clear();
      runUsageContextByRunIdRef.current.clear();
      activeAssistantForegroundRunIdRef.current = null;
    },
    []
  );

  const getActiveRunUsageContext = useCallback((): AssistantRunUsageContext | null => {
    const runId = activeAssistantForegroundRunIdRef.current;
    if (!runId) {
      return null;
    }
    return runUsageContextByRunIdRef.current.get(runId) ?? null;
  }, []);

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
            runUsageContextByRunIdRef.current.delete(runId);
            if (activeAssistantForegroundRunIdRef.current === runId) {
              activeAssistantForegroundRunIdRef.current = null;
            }
          },
        })
      );
      // Snapshot the model/provider that will PRODUCE this run's tokens. create
      // AssistantThreadRunPromise already throws unless both are set, so a run
      // id implies both are present here.
      if (selectedProvider && resolvedModelName) {
        runUsageContextByRunIdRef.current.set(runId, {
          model: resolvedModelName,
          provider: selectedProvider,
          // Snapshot the focused root too — focus can change mid-run, so
          // durable usage must attribute to the root the run operated on.
          // No focused root → null (honest "unattributed", never a fake root).
          rootId: focusedRootId ?? null,
          runId,
        });
      }
      activeAssistantForegroundRunIdRef.current = runId;
    }

    // Read the persisted plan-mode toggle FRESH here, at request-composition
    // time, instead of trusting `requestData.planMode` (a value computed at
    // the RENDER that produced the `requestData` object/closure this callback
    // captured). `useAssistantPreferencesStore.getState()` reads the zustand
    // store's live internal state directly — updated synchronously by
    // `setPlanModeEnabled`, not gated on a React re-render/flush. This closes
    // the approve-exits-plan-mode race: `SubmitPlanNotice.approve` flips the
    // store off and then immediately submits the resume in the SAME
    // synchronous handler, with no guarantee a re-render lands in between.
    // `planMode` is presence-means-on: explicitly set `undefined` (never
    // `false`) so it always overrides a stale `true` inherited from
    // `requestData` and drops off the wire on JSON.stringify.
    const freshPlanModeEnabled =
      planModeAvailable && useAssistantPreferencesStore.getState().planModeEnabled;

    return {
      ...requestData,
      memory: {
        ...memoryContext,
        ...(runId ? { runId } : {}),
      },
      planMode: freshPlanModeEnabled ? true : undefined,
    };
  }, [
    assistantThreadRepository,
    focusedRootId,
    memoryResourceId,
    modelSettings,
    planModeAvailable,
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
        runUsageContextByRunIdRef.current.delete(runId);
        if (activeAssistantForegroundRunIdRef.current === runId) {
          activeAssistantForegroundRunIdRef.current = null;
        }
      }
    },
    [assistantThreadRepository]
  );

  return {
    completePreparedRequest,
    getActiveRunUsageContext,
    prepareRequestData,
    renewActiveAssistantForegroundActivity,
  };
}
