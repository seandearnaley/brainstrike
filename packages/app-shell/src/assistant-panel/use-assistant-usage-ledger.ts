/**
 * Assistant run-usage ledger.
 *
 * BST-1652: extracted whole (comments and ordering intact) from
 * `assistant-ui-panel-wrapper.tsx`, where it was ~215 interleaved lines of the
 * composition module. One cohesive concern — the transient context-usage store
 * sinks and the durable `brainstrike_assistant_run_usage` rows behind them —
 * with a single entry point.
 *
 * Ownership is unchanged, and the rules it encodes stay load-bearing:
 *  - ONE usage derivation fans out to the session store and (desktop only) the
 *    durable per-run row; the durable sink is capability-gated on the PGlite
 *    thread repository, never an `isElectron()` check and never a fabricated $0.
 *  - model/provider/root are attributed from the REQUEST-START snapshot, never
 *    the live picker, so the picker stays interactive mid-run.
 *  - the live step sum is cleared only AFTER the refreshed cumulative absorbed
 *    the run's row, so the thread total never dips and jumps.
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

interface UseAssistantUsageLedgerArgs {
  readonly assistantThreadRepository: AssistantThreadRepository | null;
  readonly completePreparedRequest: (
    requestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void>;
  readonly getActiveRunUsageContext: () => AssistantRunUsageContext | null;
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  readonly localChatTransport: 'data-stream' | 'local-runtime';
  readonly memoryResourceId: string;
  readonly refreshThreadsAfterRun: () => void;
  readonly selectedMemoryThreadId: string | undefined;
  readonly selectedProvider: SupportedProvider | null;
}

interface UseAssistantUsageLedgerResult {
  readonly completeRequestAndSettleLiveUsage: (
    preparedRequestData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void>;
  readonly cumulativeUsage: CumulativeUsageDisplay | null;
  readonly handleChildRunUsage: (data: unknown) => void;
  readonly handleContextBreakdown: (data: unknown) => void;
  readonly handleStepUsage: (step: { inputTokens: number; outputTokens: number }) => void;
  readonly handleUsage: (usage: AssistantRunUsagePayload) => void;
}

export function useAssistantUsageLedger({
  assistantThreadRepository,
  completePreparedRequest,
  getActiveRunUsageContext,
  getProviderLlmModels,
  localChatTransport,
  memoryResourceId,
  refreshThreadsAfterRun,
  selectedMemoryThreadId,
  selectedProvider,
}: UseAssistantUsageLedgerArgs): UseAssistantUsageLedgerResult {
  // Bumped after each durable usage write COMMITS, so the cumulative re-read is
  // Durable CUMULATIVE usage for the active thread, hydrated from the DB (honest,
  // not a heuristic). Desktop-only: when the repo is absent (web) the cumulative
  // line is simply not shown.
  const [cumulativeUsage, setCumulativeUsage] = useState<CumulativeUsageDisplay | null>(null);
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
  const completeRequestAndSettleLiveUsage = useCallback(
    async (
      preparedRequestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ): Promise<void> => {
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
    cumulativeUsageLoadIdRef.current += 1;
    const loadId = cumulativeUsageLoadIdRef.current;
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      setCumulativeUsage(null);
      return;
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
      setCumulativeUsage(next);
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

  // A thread that just became selected cannot have an in-flight accumulation
  // of its own (runs stream on the selected thread), so any lingering live
  // sum on it is a stranded remainder — e.g. steps recorded before the user
  // switched away mid-run (review fix: the switch re-keys handleStepUsage to
  // the new thread, so the old thread's partial sum would otherwise persist
  // until an unrelated later run cleared it). Keyed ONLY on the thread id —
  // the refresh effect above also refires on pricing/repo identity changes,
  // which must not wipe a genuinely live sum mid-run.
  useEffect(() => {
    useContextUsageStore.getState().clearLiveRunUsage(selectedMemoryThreadId ?? 'active');
  }, [selectedMemoryThreadId]);

  return {
    completeRequestAndSettleLiveUsage,
    cumulativeUsage,
    handleChildRunUsage,
    handleContextBreakdown,
    handleStepUsage,
    handleUsage,
  };
}
