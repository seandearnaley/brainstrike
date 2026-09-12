/**
 * Assistant usage ledger — the thread's token/cost bookkeeping for one panel.
 *
 * BST-1652: extracted whole out of `assistant-ui-panel-wrapper.tsx`. It owns
 * every write into the session-lived context-usage store and the durable
 * `brainstrike_assistant_run_usage` rows, plus the cumulative re-read that
 * feeds the meter's thread-total headline. The wrapper keeps none of it: it
 * supplies the seams and forwards the returned handlers to the panel.
 *
 * Sink shape (unchanged by the extraction):
 *   - session store (`useContextUsageStore`) — last-turn exact usage, the
 *     run-start prompt breakdown, and the in-flight run's live step sum, all
 *     keyed by the selected memory thread id (falling back to 'active').
 *   - durable rows — desktop only, gated on the PGlite-backed thread repo
 *     EXISTING (capability, never an `isElectron()` check). Web simply has no
 *     durable sink; it is never faked and never $0.
 *
 * The live step sum has THREE clear paths. Two settle the run that produced it:
 * `handleUsage` (only AFTER the post-write refresh, so the total never dips
 * and jumps) and the wrapped `completePreparedRequest` on a cancelled/failed
 * terminal status (the abort-gated usage tap never delivers those runs'
 * finish). Both key off the CURRENT selection, so a mid-stream thread switch
 * strands the partial sum on the thread the user left; the third path is the
 * wrapped `prepareRequestData` — a run STARTING on a thread owns that thread's
 * live sum from zero, so it resets it first (BST-1652). The meter's `isRunning`
 * gate covers the idle half of the same fact: a stranded sum is invisible until
 * a run starts, and a starting run clears it before it can be read as its own.
 */

import { parseAssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import {
  isSupportedProvider,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { isAssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import {
  type AssistantThreadRepository,
  type CumulativeUsageDisplay,
  EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY,
  type ModelPricingResolver,
  resolveCumulativeUsageDisplay,
} from '@brainstrike/assistant-data';
import { useContextUsageStore } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AssistantRunUsagePayload,
  hasContextBreakdownChannel,
  type LlmProviderModelDefinition,
  pickCacheTokenFields,
  pickContextMeterUsage,
} from '../assistant-ui-panel-wrapper-runtime';
import type { AssistantRunUsageContext } from '../hooks/use-assistant-request-lifecycle';

const assistantUsageWriteBackLogger = createLogger('AssistantUsageWriteBack');

/** Terminal status reported to the request lifecycle when a run settles. */
type PreparedRequestStatus = 'cancelled' | 'completed' | 'failed';

type CompletePreparedRequest = (
  preparedRequestData: Record<string, unknown> | undefined,
  status: PreparedRequestStatus,
  error?: string
) => Promise<void>;

/**
 * The wrapper's request-composition seam (rewind finalization already composed
 * in). Structural mirror of `changes/use-rewind-finalization.ts` — the ledger
 * wraps it, never replaces it.
 */
type PrepareRequestData = (
  abortSignal?: AbortSignal,
  turnAnchorMessageId?: string | null,
  runConfig?: unknown
) => Promise<Record<string, unknown>>;

export interface UseAssistantUsageLedgerInput {
  /** Desktop PGlite-backed repo, or null on web (no durable sink). */
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  /** Raw lifecycle completion; the ledger wraps it to settle the live sum. */
  readonly completePreparedRequest: CompletePreparedRequest;
  /** Request-START model/provider/root snapshot for the in-flight run. */
  readonly getActiveRunUsageContext: () => AssistantRunUsageContext | null;
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  readonly localChatTransport: 'data-stream' | 'local-runtime';
  readonly memoryResourceId: string;
  /** Request composition — the run-start event; the ledger wraps it to reset the live sum. */
  readonly prepareRequestData: PrepareRequestData;
  /** Thread recency/ordering refresh fired after each turn's usage lands. */
  readonly refreshThreadsAfterRun: () => void;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedProvider: SupportedProvider | null;
}

export interface AssistantUsageLedger {
  /** `completePreparedRequest` wrapped to clear the live sum on a non-completed run. */
  readonly completeRequestAndSettleLiveUsage: CompletePreparedRequest;
  /** Durable thread total, or null when unread/unreadable (never a fabricated $0). */
  readonly cumulativeUsage: CumulativeUsageDisplay | null;
  readonly handleChildRunUsage: (data: unknown) => void;
  readonly handleContextBreakdown: (data: unknown) => void;
  readonly handleStepUsage: (step: { inputTokens: number; outputTokens: number }) => void;
  readonly handleUsage: (usage: AssistantRunUsagePayload) => void;
  /** `prepareRequestData` wrapped to reset the thread's live sum at run start. */
  readonly prepareRequestAndResetLiveUsage: PrepareRequestData;
}

export function useAssistantUsageLedger({
  assistantThreadRepository,
  completePreparedRequest,
  getActiveRunUsageContext,
  getProviderLlmModels,
  localChatTransport,
  memoryResourceId,
  prepareRequestData,
  refreshThreadsAfterRun,
  selectedMemoryThreadId,
  selectedProvider,
}: UseAssistantUsageLedgerInput): AssistantUsageLedger {
  // Durable CUMULATIVE usage for the active thread, hydrated from the DB
  // (honest, not a heuristic). Desktop-only: when the repo is absent (web) the
  // cumulative line is simply not shown.
  //
  // The LOADED value is state; "there is nothing to load" is DERIVED. Without a
  // repo or a selected thread there is no durable sink and therefore no thread
  // total — a fact about this render's inputs, not an event to react to. Having
  // the loader null the state instead put a synchronous setState in the load
  // effect (invisible while this lived in the 1,900-line wrapper, which exceeds
  // the React Compiler's analysis budget; the extraction made it reportable).
  const [loadedCumulativeUsage, setLoadedCumulativeUsage] = useState<CumulativeUsageDisplay | null>(
    null
  );
  const hasDurableUsageSink = Boolean(assistantThreadRepository && selectedMemoryThreadId);
  const cumulativeUsage = hasDurableUsageSink ? loadedCumulativeUsage : null;

  const clearThreadLiveRunUsage = useCallback(() => {
    useContextUsageStore.getState().clearLiveRunUsage(selectedMemoryThreadId ?? 'active');
  }, [selectedMemoryThreadId]);

  // Terminal run bookkeeping + live-sum hygiene (review fix): a cancelled or
  // failed run may never reach the abort-gated onUsage tap, so its accumulated
  // live step usage would linger as phantom thread-total tokens (and a stuck
  // 'live' badge) until the next successful run. Clear it on any non-completed
  // terminal status; 'completed' rides handleUsage's own post-refresh clear.
  // Thread attribution uses the CURRENT selection — a mid-run thread switch
  // could miss, acceptable for a transient display sum.
  const completeRequestAndSettleLiveUsage = useCallback<CompletePreparedRequest>(
    async (preparedRequestData, status, error) => {
      try {
        await completePreparedRequest(preparedRequestData, status, error);
      } finally {
        if (status !== 'completed') {
          clearThreadLiveRunUsage();
        }
      }
    },
    [clearThreadLiveRunUsage, completePreparedRequest]
  );

  // Run-start reset (review fix): the run about to be composed owns this
  // thread's live sum from zero. Anything still under the key belongs to an
  // EARLIER run that never settled here — a mid-stream thread switch re-keys
  // both handleStepUsage and both settle-side clears to the newly selected
  // thread, so the run the user walked away from leaves its partial sum
  // behind. The meter's `isRunning` gate hides that only while the thread is
  // idle: without this reset the new run would flip the gate open on the
  // stranded tokens and then accumulate its own steps ON TOP of them, leaving
  // the headline inflated and its cost suppressed for the whole run.
  //
  // Cleared SYNCHRONOUSLY, before the underlying preparation (which awaits a
  // run-row write) — the reset must not trail the render that turns the gate
  // on. Runs are serialized per prepared request ('Cannot start a hosted
  // assistant run while another run is in progress'), so a live sum that is
  // genuinely this thread's own in-flight accumulation cannot exist here.
  const prepareRequestAndResetLiveUsage = useCallback<PrepareRequestData>(
    (abortSignal, turnAnchorMessageId, runConfig) => {
      clearThreadLiveRunUsage();
      return prepareRequestData(abortSignal, turnAnchorMessageId, runConfig);
    },
    [clearThreadLiveRunUsage, prepareRequestData]
  );

  const resolveModelPricing = useCallback<ModelPricingResolver>(
    (provider: string, model: string) => {
      if (!isSupportedProvider(provider)) {
        return;
      }
      return getProviderLlmModels(provider).find(
        (candidate: LlmProviderModelDefinition) => candidate.id === model
      )?.pricing;
    },
    [getProviderLlmModels]
  );

  // Monotonic load token: a slower in-flight load (e.g. an earlier thread) must
  // never clobber a newer one. Every loader captures the id at call time and only
  // commits state if it is still the latest — a single setState path (no
  // cascading sets, no separate cancel flag per call).
  const cumulativeUsageLoadIdRef = useRef(0);
  const refreshCumulativeUsage = useCallback(async (): Promise<void> => {
    // Bumping first invalidates any in-flight load, so a slower read for a
    // previous thread cannot land after the sink disappeared.
    cumulativeUsageLoadIdRef.current += 1;
    const loadId = cumulativeUsageLoadIdRef.current;
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      return; // no sink — `cumulativeUsage` derives null; nothing to read
    }
    let next: CumulativeUsageDisplay | null = null;
    try {
      const usage =
        await assistantThreadRepository.getThreadCumulativeUsage(selectedMemoryThreadId);
      // A repo-backed thread with no rows yet is an honest ZERO baseline, not
      // "no thread totals": the first run's live step usage must render as the
      // thread-total headline (review fix), which the meter only does over a
      // present cumulative value. A LOAD FAILURE stays null — "couldn't read"
      // must never display as $0.00.
      next =
        resolveCumulativeUsageDisplay(usage, resolveModelPricing) ??
        EMPTY_THREAD_CUMULATIVE_USAGE_DISPLAY;
    } catch (error: unknown) {
      assistantUsageWriteBackLogger.warn('Failed to load cumulative run usage', { error });
    }
    if (loadId === cumulativeUsageLoadIdRef.current) {
      setLoadedCumulativeUsage(next);
    }
  }, [assistantThreadRepository, resolveModelPricing, selectedMemoryThreadId]);

  // Record the run-start prompt breakdown (transient context-breakdown data
  // part). Parsed with the contract guard so a malformed wire payload is stored
  // as the explicit { invalid: true } marker the popover surfaces — never
  // coerced, never dropped. Keyed by the SAME thread key contract as
  // recordUsage (writer and meter reader must agree).
  const handleContextBreakdown = useCallback(
    (data: unknown) => {
      const threadId = selectedMemoryThreadId ?? 'active';
      useContextUsageStore
        .getState()
        .recordBreakdown(threadId, parseAssistantContextBreakdown(data));
    },
    [selectedMemoryThreadId]
  );

  // Child model-call usage (subagent / OM cycle, BST-953). The desktop server
  // already wrote the durable row before the transient part reached the wire
  // (its write queue may still be committing — the post-run refresh is the
  // backstop); the renderer only re-reads so the thread total moves mid-run.
  const handleChildRunUsage = useCallback(
    (data: unknown) => {
      if (!isAssistantChildRunUsage(data)) {
        assistantUsageWriteBackLogger.warn('Ignoring malformed child-run-usage part', { data });
        return;
      }
      void refreshCumulativeUsage();
    },
    [refreshCumulativeUsage]
  );

  // Live thread-total tick (BST-953): accumulate the in-flight run's billed
  // step usage; handleUsage clears the sum once the run's durable row lands.
  const handleStepUsage = useCallback(
    (step: { inputTokens: number; outputTokens: number }) => {
      useContextUsageStore.getState().recordLiveStepUsage(selectedMemoryThreadId ?? 'active', step);
    },
    [selectedMemoryThreadId]
  );

  // Record provider token usage. ONE usage derivation (the single tap) fans out
  // to two sinks:
  //   1. the session-lived zustand store (last-turn meter), keyed by the active
  //      memory thread id (falls back to 'active' for non-memory sessions);
  //   2. a DURABLE per-run row in brainstrike_assistant_run_usage, written only
  //      when the PGlite-backed thread repo exists (desktop). On web the repo is
  //      absent → the durable write is simply skipped (honest session-only
  //      fallback; capability-gated, never an isElectron() check and never $0).
  // model/provider are attributed from the REQUEST-START snapshot (the model that
  // produced the tokens), never the live picker selection — the picker stays
  // interactive mid-run. They are stored PER ROW so cost is attributable per
  // model when a thread switches models mid-conversation.
  const handleUsage = useCallback(
    (usage: AssistantRunUsagePayload) => {
      const threadId = selectedMemoryThreadId ?? 'active';
      // A turn on a capability-absent transport (the in-renderer local
      // runtime) can never have refreshed the breakdown — drop a stale one
      // left over from an earlier hosted turn on the SAME thread so the
      // popover never mixes one turn's category rows with another turn's
      // exact totals (review fix).
      if (!hasContextBreakdownChannel(selectedProvider, localChatTransport)) {
        useContextUsageStore.getState().clearBreakdown(threadId);
      }
      useContextUsageStore.getState().recordUsage(threadId, pickContextMeterUsage(usage));
      // Keep recency, latest-run details, and ordering fresh after each turn.
      // Live title sync handles the later async write and logs subscription failures.
      refreshThreadsAfterRun();

      // Durable sink: requires a real thread id, the desktop PGlite repo, and the
      // in-flight run's request-start usage context. A missing piece means we
      // cannot attribute the row honestly, so we skip the durable write (the
      // zustand sink still ran).
      const runContext = getActiveRunUsageContext();
      if (!(assistantThreadRepository && selectedMemoryThreadId && runContext)) {
        // No durable sink → no refreshed cumulative will absorb the live sum;
        // drop it now (the run is over, the exact usage is in the store).
        useContextUsageStore.getState().clearLiveRunUsage(threadId);
        return;
      }
      // From here the run has stopped streaming, so `thread.isRunning` is already
      // false, but the live sum must stay visible until the refreshed cumulative
      // absorbs the row below. Claimed only now, past the no-sink guard: without a
      // durable write there is no window to protect. The release is structural —
      // `finally` for the chain, `catch` for a SYNCHRONOUS throw that never
      // reaches it — because a claim that outlives its sum is strictly worse than
      // no claim at all: it holds the reader gate open on an idle thread and the
      // headline stays inflated until some later run on that thread settles.
      try {
        // Inside the `try`: zustand assigns the next state and THEN notifies
        // synchronously, so a throwing subscriber escapes `set` with the claim
        // already taken. Clearing when nothing was claimed is a defined no-op,
        // so one `catch` covers both "claimed then threw" and "never claimed".
        useContextUsageStore.getState().beginLiveRunUsageSettle(threadId);
        assistantThreadRepository
          .recordRunUsage({
            ...(usage.billedCostUsd === undefined ? {} : { billedCostUsd: usage.billedCostUsd }),
            ...pickCacheTokenFields(usage),
            inputTokens: usage.inputTokens,
            model: runContext.model,
            outputTokens: usage.outputTokens,
            provider: runContext.provider,
            resourceId: memoryResourceId,
            // Request-start root (null when unattributed) — same snapshot source
            // as model/provider, so cost is attributable per workspace root.
            rootId: runContext.rootId,
            runId: runContext.runId,
            threadId: selectedMemoryThreadId,
          })
          // Re-read the cumulative total from the write's OWN completion so the
          // SELECT provably follows the INSERT (not racing it on the PGlite queue).
          .then(() => refreshCumulativeUsage())
          .catch((error: unknown) => {
            // Never swallow silently — durable usage is best-effort relative to the
            // turn, but a failure must be observable.
            assistantUsageWriteBackLogger.warn('Failed to persist durable run usage', { error });
          })
          // Clear the live sum only AFTER the refreshed cumulative absorbed the
          // run's row (clearing earlier makes the thread total dip and jump).
          .finally(() => {
            useContextUsageStore.getState().clearLiveRunUsage(threadId);
          });
      } catch (error) {
        // A SYNCHRONOUS throw never reaches the chain's `finally`, so the claim
        // would outlive the sum and hold the gate open on an idle thread.
        // Release FIRST: a throwing logger must not be what strands it.
        useContextUsageStore.getState().clearLiveRunUsage(threadId);
        assistantUsageWriteBackLogger.warn('Failed to start the durable run usage write', {
          error,
        });
      }
    },
    [
      assistantThreadRepository,
      getActiveRunUsageContext,
      localChatTransport,
      memoryResourceId,
      refreshCumulativeUsage,
      refreshThreadsAfterRun,
      selectedMemoryThreadId,
      selectedProvider,
    ]
  );

  // Initial / thread-switch load. The post-write refresh rides handleUsage's
  // own completion, so this effect only fires on repo/thread change.
  useEffect(() => {
    void refreshCumulativeUsage();
  }, [refreshCumulativeUsage]);

  return {
    completeRequestAndSettleLiveUsage,
    cumulativeUsage,
    handleChildRunUsage,
    handleContextBreakdown,
    handleStepUsage,
    handleUsage,
    prepareRequestAndResetLiveUsage,
  };
}
