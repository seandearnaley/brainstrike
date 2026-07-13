import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { getPermissionToolGateSnapshotInput } from '@brainstrike/preferences/stores/permission-policy-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
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
   * Whether the current transport can enforce permissions at all (mirrors the
   * caller's `permissionPolicyRequest` transport gate — only the desktop
   * data-stream server runs the runtime gate; web's in-renderer runtime has no
   * server). Combined at request-composition time with a FRESH read of the
   * persisted policy posture (see `prepareRequestData`), so a per-tool
   * "Always allow" / session grant recorded synchronously right before a
   * grant-and-approve resume reaches THIS run instead of the next re-render.
   */
  readonly permissionEnforceable: boolean;
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

/**
 * Overlay the LIVE workspace-index status onto the render-captured value at
 * request-composition time. The wrapper intentionally does NOT live-subscribe
 * to per-file indexing progress (that re-rendered the whole assistant panel per
 * processed file during initial indexing), so the render-captured status fields
 * can be thousands of progress patches stale by send time. The preference-shaped
 * fields (enabled/mode/paused/embeddingSetId) stay from the render — the wrapper
 * still subscribes to those (they change rarely). Returns undefined when the
 * request carries no workspace-index object (nothing to refresh).
 */
function resolveFreshWorkspaceIndex(captured: unknown): Record<string, unknown> | undefined {
  if (!(captured && typeof captured === 'object' && !Array.isArray(captured))) {
    return;
  }
  const sync = useWorkspaceCollectionSyncStatusStore.getState();
  return {
    ...(captured as Record<string, unknown>),
    blockedReason: sync.blockedReason,
    lastError: sync.lastError,
    queueProgress: sync.queueProgress,
    statusState: sync.state,
  };
}

export function useAssistantRequestLifecycle({
  assistantThreadRepository,
  focusedRootId,
  memoryResourceId,
  modelSettings,
  permissionEnforceable,
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

    const freshWorkspaceIndex = resolveFreshWorkspaceIndex(requestData['workspaceIndex']);

    // Same fresh-read rationale as `planMode` above, for permission enforcement.
    // A grant action on the approval notice ("Always allow" / "Allow <category>
    // this session") records the override/grant in the store and then, in the
    // SAME synchronous handler, approves the pending call — which resumes the
    // run through this composer. `requestData.permissionPolicyRequest` was
    // snapshotted at the render that produced this closure, so without a fresh
    // read the resumed run's gate would still treat the just-granted tool as
    // `ask` and could re-prompt until a later re-render. Read the live store
    // posture here so the grant takes effect on THIS run. `permissionEnforceable`
    // mirrors the wrapper's transport gate (only the data-stream server
    // enforces); `enforce` is read fresh. Presence-means-on: set `undefined`
    // (never a stale object) so an off/opted-out posture drops off the wire.
    const freshPermissionSnapshot = getPermissionToolGateSnapshotInput();
    const freshPermissionPolicyRequest =
      permissionEnforceable && freshPermissionSnapshot.enforce
        ? freshPermissionSnapshot
        : undefined;

    return {
      ...requestData,
      memory: {
        ...memoryContext,
        ...(runId ? { runId } : {}),
      },
      permissionPolicyRequest: freshPermissionPolicyRequest,
      planMode: freshPlanModeEnabled ? true : undefined,
      ...(freshWorkspaceIndex ? { workspaceIndex: freshWorkspaceIndex } : {}),
    };
  }, [
    assistantThreadRepository,
    focusedRootId,
    memoryResourceId,
    modelSettings,
    permissionEnforceable,
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
