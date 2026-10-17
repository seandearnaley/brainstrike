import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { getPermissionToolGateSnapshotInput } from '@brainstrike/app-state/stores/permission-policy-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type { RuntimeData } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import {
  type AssistantThreadRepository,
  hasDurableAssistantUsageCapability,
} from '@brainstrike/assistant-data';
import { useCallback, useEffect, useRef } from 'react';
import {
  type AssistantForegroundActivityLease,
  acquireAssistantForegroundActivity,
} from '../assistant-foreground-activity';
import {
  createAssistantThreadRunPromise,
  extractPreparedRunId,
  resolveHostedMemoryBackendAvailable,
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
  /**
   * Whether this shell has a durable memory backend, so each request carries a
   * memory block. Defaults to this shell's capability through
   * `resolveHostedMemoryBackendAvailable`, the resolver the request data uses.
   * Without one (web), a turn runs with no memory, as the panel notice says
   * (owner decision 2026-10-17): the request omits the block, and its run id
   * stays with the prepared request.
   */
  readonly memoryBackendAvailable?: boolean;
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
  readonly persistThreadRootBinding?: (
    binding: Omit<AssistantThreadRootBinding, 'persisted'>
  ) => Promise<void>;
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
  readonly resolveThreadRootBinding?: () => Promise<
    PersistedAssistantThreadRootBinding | undefined
  >;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedProvider: SupportedProvider | null;
  readonly threadRootBinding?: AssistantThreadRootBinding | undefined;
}

export interface AssistantThreadRootBinding {
  readonly displayName: string;
  readonly path?: string | undefined;
  readonly persisted: boolean;
  readonly rootId: string;
}

type PersistedAssistantThreadRootBinding = Omit<AssistantThreadRootBinding, 'persisted'>;

interface ThreadRootBindingRefValue {
  readonly binding: PersistedAssistantThreadRootBinding;
  readonly threadId: string;
}

function toPersistedThreadRootBinding(
  binding: AssistantThreadRootBinding
): PersistedAssistantThreadRootBinding {
  return {
    displayName: binding.displayName,
    ...(binding.path ? { path: binding.path } : {}),
    rootId: binding.rootId,
  };
}

async function resolvePreparedThreadRootBinding(args: {
  readonly current: ThreadRootBindingRefValue | null;
  readonly persist?: (binding: PersistedAssistantThreadRootBinding) => Promise<void> | undefined;
  readonly proposed?: AssistantThreadRootBinding | undefined;
  readonly resolve: (() => Promise<PersistedAssistantThreadRootBinding | undefined>) | undefined;
  readonly threadId?: string | undefined;
}): Promise<PersistedAssistantThreadRootBinding | undefined> {
  if (args.proposed?.persisted) {
    return toPersistedThreadRootBinding(args.proposed);
  }
  const current = args.current;
  if (current && current.threadId === args.threadId) {
    return current.binding;
  }
  const binding = args.proposed
    ? toPersistedThreadRootBinding(args.proposed)
    : await args.resolve?.();
  if (!binding) {
    return;
  }
  if (!(args.threadId && args.persist)) {
    throw new Error('Assistant thread root binding cannot be persisted.');
  }
  await args.persist(binding);
  return binding;
}

function requireRequestMemoryContext(
  requestData: Record<string, unknown>
): Record<string, unknown> {
  const memoryContext = requestData['memory'];
  if (!(memoryContext && typeof memoryContext === 'object' && !Array.isArray(memoryContext))) {
    throw new Error('Assistant request preparation requires Mastra memory context.');
  }
  return memoryContext as Record<string, unknown>;
}

/** The request's memory block, or none for a shell without a memory backend. */
function readPreparedMemoryContext(
  requestData: Record<string, unknown>,
  memoryBackendAvailable: boolean
): Record<string, unknown> | undefined {
  // A missing block with a backend present is a wiring bug and still refuses.
  return memoryBackendAvailable ? requireRequestMemoryContext(requestData) : undefined;
}

function withRunMemory(
  memoryContext: Record<string, unknown> | undefined,
  runId: string | undefined
): Record<string, unknown> {
  return memoryContext ? { memory: { ...memoryContext, ...(runId ? { runId } : {}) } } : {};
}

/** A memory-less request keeps its run id with the prepared object; the wire never carries it. */
function rememberMemorylessRun(
  runIds: WeakMap<object, string>,
  prepared: Record<string, unknown>,
  memoryContext: Record<string, unknown> | undefined,
  runId: string | undefined
): void {
  if (!memoryContext && runId) {
    runIds.set(prepared, runId);
  }
}

function buildBoundRootRequestData(
  binding: PersistedAssistantThreadRootBinding | undefined
): Record<string, unknown> {
  if (!binding) {
    return {};
  }
  return {
    boundWorkspaceRootId: binding.rootId,
    mainRootId: binding.rootId,
    mainRootPath: binding.path,
  };
}

function resolveRequestPreparationSignal(abortSignal?: AbortSignal): AbortSignal {
  if (abortSignal) {
    return abortSignal;
  }
  return new AbortController().signal;
}

function runWhileRequestPreparationActive(abortSignal: AbortSignal, callback: () => void): void {
  if (abortSignal.aborted) {
    return;
  }
  callback();
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
    error?: string,
    hostOwnsRun?: boolean
  ) => Promise<void>;
  /**
   * The active run's request-start usage context, or null when no run is in
   * flight. Reads from a ref so the usage callback attributes durable rows to
   * the model that produced the tokens, not the current picker selection.
   */
  readonly getActiveRunUsageContext: () => AssistantRunUsageContext | null;
  /**
   * The in-flight run's id for CONTROL actions (mid-run steering, BST-588),
   * or null when no run is in flight. Deliberately NOT derived from the
   * foreground-activity lease: that lease is a QoS/power concern whose 5-minute
   * idle fuse clears its ref during silent hosted/tool gaps while the run is
   * still very much alive. Cleared only at true run completion, so a steer
   * after a long silent gap still reaches the server.
   */
  readonly getActiveSteerableRunId: () => string | null;
  readonly prepareRequestData: (
    abortSignal?: AbortSignal,
    turnAnchorMessageId?: string | null,
    runConfig?: unknown
  ) => Promise<Record<string, unknown>>;
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
  memoryBackendAvailable = resolveHostedMemoryBackendAvailable({
    desktopAssistantBackendAvailable: hasDurableAssistantUsageCapability(),
  }),
  memoryResourceId,
  modelSettings,
  permissionEnforceable,
  persistThreadRootBinding,
  planModeAvailable,
  providerOptions,
  requestData,
  resolveThreadRootBinding,
  resolvedModelName,
  selectedMemoryThreadId,
  selectedProvider,
  threadRootBinding,
}: UseAssistantRequestLifecycleArgs): UseAssistantRequestLifecycleResult {
  const assistantForegroundActivityLeaseByRunIdRef = useRef(
    new Map<string, AssistantForegroundActivityLease>()
  );
  // The run currently streaming (runs are serialized per panel). Stream activity
  // renews only this run's lease, so unrelated active runs cannot keep leaked
  // sibling leases alive indefinitely.
  const activeAssistantForegroundRunIdRef = useRef<string | null>(null);
  // A memory-less request's run id, by the prepared request object the session
  // hands back to completion; the wire never carries it.
  const memorylessRunIdsRef = useRef(new WeakMap<object, string>());
  /**
   * Run-lifecycle-accurate active run id for control actions (steering).
   * Set at request start, cleared ONLY by completePreparedRequest — never by
   * the foreground lease's idle fuse (see getActiveSteerableRunId).
   */
  const activeSteerableRunIdRef = useRef<string | null>(null);
  const threadRootBindingRef = useRef<ThreadRootBindingRefValue | null>(null);
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
      activeSteerableRunIdRef.current = null;
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

  const getActiveSteerableRunId = useCallback(
    (): string | null => activeSteerableRunIdRef.current,
    []
  );

  const renewActiveAssistantForegroundActivity = useCallback(() => {
    const runId = activeAssistantForegroundRunIdRef.current;
    if (!runId) {
      return;
    }
    assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.renew();
  }, []);

  const activatePreparedRun = useCallback(
    (
      runId: string | undefined,
      rootBinding: PersistedAssistantThreadRootBinding | undefined
    ): void => {
      if (!runId) {
        return;
      }
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
      if (selectedProvider && resolvedModelName) {
        runUsageContextByRunIdRef.current.set(runId, {
          model: resolvedModelName,
          provider: selectedProvider,
          rootId: rootBinding?.rootId ?? focusedRootId ?? null,
          runId,
        });
      }
      activeAssistantForegroundRunIdRef.current = runId;
      activeSteerableRunIdRef.current = runId;
    },
    [focusedRootId, resolvedModelName, selectedProvider]
  );

  const prepareRequestData = useCallback(
    async (
      abortSignal?: AbortSignal,
      turnAnchorMessageId?: string | null,
      runConfig?: unknown
    ): Promise<Record<string, unknown>> => {
      const preparationSignal = resolveRequestPreparationSignal(abortSignal);
      preparationSignal.throwIfAborted();
      const memoryContext = readPreparedMemoryContext(requestData, memoryBackendAvailable);
      const activeThreadRootBinding = await resolvePreparedThreadRootBinding({
        current: threadRootBindingRef.current,
        ...(persistThreadRootBinding ? { persist: persistThreadRootBinding } : {}),
        ...(threadRootBinding ? { proposed: threadRootBinding } : {}),
        resolve: resolveThreadRootBinding,
        ...(selectedMemoryThreadId ? { threadId: selectedMemoryThreadId } : {}),
      });
      preparationSignal.throwIfAborted();
      if (activeThreadRootBinding && selectedMemoryThreadId) {
        threadRootBindingRef.current = {
          binding: activeThreadRootBinding,
          threadId: selectedMemoryThreadId,
        };
      }

      const runId = await createAssistantThreadRunPromise({
        assistantThreadRepository,
        memoryResourceId,
        modelSettings,
        providerOptions,
        resolvedModelName,
        runConfig,
        selectedMemoryThreadId,
        selectedProvider,
        turnMessageId: turnAnchorMessageId ?? null,
      });
      runWhileRequestPreparationActive(preparationSignal, () => {
        activatePreparedRun(runId, activeThreadRootBinding);
      });

      // Read the persisted plan-mode toggle FRESH here, at request-composition
      // time, instead of trusting `requestData.planMode` (a value computed at
      // the RENDER that produced the `requestData` object/closure this callback
      // captured). `useAssistantPreferencesStore.getState()` reads the zustand
      // store's live internal state directly — updated synchronously by
      // `setPlanModeEnabled`, not gated on a React re-render/flush. This closes
      // the approve-exits-plan-mode race: `SubmitPlanNotice.approve` flips the
      // store off and then immediately submits the resume in the SAME
      // synchronous handler, with no guarantee a re-render lands in between.
      // Written UNCONDITIONALLY as `undefined` (never `false`) when off, so it
      // always overrides a stale `true` inherited from `requestData`; the key
      // drops off the wire on JSON.stringify. Not presence-means-on — the key
      // is present here even when off.
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
      // enforces); `enforce` is read fresh. The key is written UNCONDITIONALLY
      // — `undefined` (never a stale object) for an off/opted-out posture, which
      // `JSON.stringify` drops at the wire boundary. Consumers must check the
      // VALUE; `'permissionPolicyRequest' in data` is TRUE here even when off.
      // This CANNOT be simplified to the conditional-spread pattern that
      // `subagentPersonasRequest` uses: the write must clobber a stale snapshot
      // inherited from `requestData`, not skip it (see the "fresh enforce=OFF
      // drops a stale snapshot" test).
      const freshPermissionSnapshot = getPermissionToolGateSnapshotInput();
      const freshPermissionPolicyRequest =
        permissionEnforceable && freshPermissionSnapshot.enforce
          ? freshPermissionSnapshot
          : undefined;

      const prepared: Record<string, unknown> = {
        ...requestData,
        ...buildBoundRootRequestData(activeThreadRootBinding),
        ...withRunMemory(memoryContext, runId),
        permissionPolicyRequest: freshPermissionPolicyRequest,
        planMode: freshPlanModeEnabled ? true : undefined,
        ...(freshWorkspaceIndex ? { workspaceIndex: freshWorkspaceIndex } : {}),
      };
      rememberMemorylessRun(memorylessRunIdsRef.current, prepared, memoryContext, runId);
      return prepared;
    },
    [
      assistantThreadRepository,
      activatePreparedRun,
      memoryBackendAvailable,
      memoryResourceId,
      modelSettings,
      permissionEnforceable,
      persistThreadRootBinding,
      planModeAvailable,
      providerOptions,
      requestData,
      resolveThreadRootBinding,
      resolvedModelName,
      selectedMemoryThreadId,
      selectedProvider,
      threadRootBinding,
    ]
  );

  const completePreparedRequest = useCallback(
    async (
      preparedRequestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string,
      hostOwnsRun = false
    ): Promise<void> => {
      const runId =
        extractPreparedRunId(preparedRequestData) ??
        (preparedRequestData ? memorylessRunIdsRef.current.get(preparedRequestData) : undefined);
      if (!runId) {
        return;
      }
      try {
        // Desktop owns terminal persistence after session admission. A renderer
        // disconnect must release its local leases without terminating that run.
        if (hostOwnsRun) {
          return;
        }
        if (!assistantThreadRepository) {
          throw new Error('Assistant run completion requires an active thread repository.');
        }
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
        if (activeSteerableRunIdRef.current === runId) {
          activeSteerableRunIdRef.current = null;
        }
      }
    },
    [assistantThreadRepository]
  );

  return {
    completePreparedRequest,
    getActiveRunUsageContext,
    getActiveSteerableRunId,
    prepareRequestData,
    renewActiveAssistantForegroundActivity,
  };
}
