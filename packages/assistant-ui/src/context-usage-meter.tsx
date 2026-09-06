/**
 * ContextUsageMeter — compact context gauge shown above the composer.
 *
 * One row: an SVG donut ring (context-ring.tsx) + a "used / budget" fraction.
 * The row is a popover trigger (hover, focus, and click for touch) that opens
 * the "Context Usage" detail panel (context-usage-popover.tsx) holding the
 * breakdown list, OM stats, and cumulative tokens + cost. Sources usage from
 * the zustand store (exact, post-turn) and falls back to a heuristic estimate
 * when no exact value has been recorded yet.
 *
 * Threshold states (fraction of effectiveInputBudget):
 *   ok      < 75%
 *   warning ≥ 75%
 *   critical ≥ 90% → shows the trimming-risk notice INLINE (a warning must not
 *   hide inside a hover surface)
 */
import { useAuiState } from '@assistant-ui/react';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import { type CostEstimate, formatTokenCount, formatUsdCost } from '@brainstrike/tokenization';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ConversationTokenEstimate,
  estimateConversationTokens,
  resolveDisplayedContextUsage,
} from './context-estimate';
import { ContextRing, type ContextRingState } from './context-ring';
import { ContextUsagePopoverContent, formatCompact } from './context-usage-popover';
import { useContextUsageStore } from './context-usage-store';

/** One source's share of the thread total (BST-953). OM figures are local estimates. */
export interface CumulativeSourceUsage {
  readonly estimated: boolean;
  readonly inputTokens: number;
  readonly kind: AssistantRunUsageKind;
  readonly outputTokens: number;
}

/**
 * Durable thread-total usage, resolved upstream (structural mirror of the
 * app-shell resolver's shape — dependency direction app-shell → ui). Distinct
 * from the one-turn-lag context gauge: this is the running captured billing
 * total persisted across reloads, broken down by source (chat / subagents /
 * OM) with cache-class totals and the net caching savings. `cost` is never $0
 * for an unavailable price, and captured-only totals are visibly qualified as
 * estimates.
 */
export interface CumulativeUsageDisplay {
  readonly bySource: readonly CumulativeSourceUsage[];
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheSavings?: { readonly usdAmount: number } | undefined;
  readonly cost: CostEstimate;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Resolved observational-memory (OM) state for the active thread. Produced by the
 * app-shell resolver (assistant-om-segment.ts) and rendered as INFORMATIONAL
 * stats inside the context popover — the observation is NOT a budget segment
 * (it is retrievalMode-dependent and, when injected, already counted in chat
 * usage, so summing it into the budget would double-count / false-trip
 * over-budget; see the resolver doc). Each variant is an HONEST state — never a
 * fabricated 0:
 *   chat-only → web (no durable OM persistence); OM stats hidden.
 *   inactive  → OM disabled in settings.
 *   loading   → live query fetching (initial / thread switch); stays quiet.
 *   empty     → no OM row yet (first turn).
 *   error     → malformed OM row / live-query error (strict parse failed upstream).
 *   stats     → active/buffered OM, activation progress, and compaction saved.
 */
/**
 * Why the Auto observer could not resolve (mirrors the app-shell resolver's
 * unresolved reasons; duplicated literals keep the dependency direction
 * app-shell → ui). Drives ACTIONABLE popover copy — a paused observer must
 * say why and what would unpause it.
 */
export type OmAwaitingObserverReason =
  | 'keys-unknown'
  | 'model-not-eligible'
  | 'no-backend'
  | 'no-hosted-chat-provider';

export type OmMeterState =
  | { readonly kind: 'chat-only' }
  | { readonly kind: 'inactive' }
  /** OM is on (Auto) but no eligible observer model resolved — waiting, not off. */
  | { readonly kind: 'awaiting-observer'; readonly reason: OmAwaitingObserverReason }
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly reason: string }
  | {
      readonly kind: 'stats';
      /** Summaries generated in the async buffer but not activated yet. */
      readonly bufferedObservationTokens: number;
      /** observationTokenCount — what OM is currently holding for this thread. */
      readonly observationTokens: number;
      /** totalTokensObserved − observationTokenCount, clamped ≥ 0 (compacted away). */
      readonly compactionSavedTokens: number;
      /** Raw-message threshold that activates buffered observations. */
      readonly messageTokenThreshold: number;
      /** Raw message tokens currently progressing toward activation. */
      readonly pendingMessageTokens: number;
    };

export interface ContextUsageMeterProps {
  /** Full model context window size. Meter is hidden when absent. */
  contextWindow: number | undefined;
  /**
   * Full-part conversation walk (tool args/results, reasoning, text,
   * attachments) for the popover's conversation split and per-tool rows.
   * When present, its total also drives the gauge estimate.
   */
  conversationEstimate?: ConversationTokenEstimate | undefined;
  /**
   * Durable cumulative usage for this thread (running token total + cost),
   * hydrated from the DB. Absent on web / before hydration → the cumulative line
   * is not shown in the popover (the last-turn gauge still renders).
   */
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  /** Effective input budget (contextWindow − output reservation). Meter is hidden when absent. */
  effectiveInputBudget: number | undefined;
  /** Heuristic token estimate to display before exact usage is recorded. */
  estimatedTokens?: number | undefined;
  /** True while a run streams — the gauge shows the LIVE estimate (flagged). */
  isRunning?: boolean | undefined;
  /**
   * Resolved OM state for the active thread, rendered as INFORMATIONAL stats
   * inside the popover (observed tokens + compaction saved) — NOT a budget
   * segment. Absent → no OM line (desktop before the first resolve).
   * Desktop-only: on web the resolver supplies `{ kind: 'chat-only' }` so the
   * stats are hidden honestly. Prop name kept as `omSegment` for call-site
   * stability across the panel layers.
   */
  omSegment?: OmMeterState | undefined;
  /** Thread key — MUST match the key used by recordUsage writers (same as threadKey prop on AssistantUiPanel). Falls back to 'active'. */
  threadKey?: string | undefined;
}

function resolveUsageState(used: number, effectiveInputBudget: number): ContextRingState {
  const ratio = used / effectiveInputBudget;
  if (ratio >= 0.9) {
    return 'critical';
  }
  if (ratio >= 0.75) {
    return 'warning';
  }
  return 'ok';
}

/** Delay before a hover-out closes the popover (lets the pointer cross the gap to the content). */
const HOVER_CLOSE_DELAY_MS = 120;

interface TriggerDisplay {
  ariaLabel: string;
  /** 'est.' for the context-fraction fallback; 'live' while the total includes in-flight steps. */
  badge?: 'est.' | 'live';
  costText?: string;
  primaryText: string;
}

/**
 * Pure chip-content resolution (BST-953): with durable cumulative data the
 * chip leads with the overall thread total (+cost when priceable, 'live'
 * while the in-flight run's steps are included); without it (web / an
 * unhydrated thread) it falls back to the context used/budget fraction.
 * Kept OUTSIDE the component (module-level, like computeSegmentWidths).
 */
function resolveTriggerDisplay(params: {
  cumulativeUsage: CumulativeUsageDisplay | undefined;
  effectiveInputBudget: number;
  isEstimated: boolean;
  liveTokens: number;
  percentage: number;
  usedTokens: number;
}): TriggerDisplay {
  const { cumulativeUsage, effectiveInputBudget, isEstimated, liveTokens, percentage, usedTokens } =
    params;
  if (cumulativeUsage === undefined) {
    return {
      ariaLabel: `Context usage: ${Math.round(percentage)}% of input budget${isEstimated ? ' (estimated)' : ''}`,
      ...(isEstimated ? { badge: 'est.' as const } : {}),
      primaryText: `${formatCompact(usedTokens)} / ${formatCompact(effectiveInputBudget)}`,
    };
  }
  const threadTotalTokens = cumulativeUsage.totalTokens + liveTokens;
  return {
    ariaLabel: `Thread usage: ${formatTokenCount(threadTotalTokens)}; context ${Math.round(percentage)}% of input budget`,
    ...(liveTokens > 0 ? { badge: 'live' as const } : {}),
    // The durable cost EXCLUDES the live tokens the total now includes —
    // pairing them would present a current token count beside a lagging price
    // (review fix). The cost returns once the run's row lands and the live
    // sum clears.
    ...(cumulativeUsage.cost.available && liveTokens === 0
      ? { costText: `· ${formatUsdCost(cumulativeUsage.cost.usdAmount)}` }
      : {}),
    primaryText: `${formatCompact(threadTotalTokens)} tokens`,
  };
}

export const ContextUsageMeter = ({
  threadKey,
  contextWindow,
  conversationEstimate,
  cumulativeUsage,
  effectiveInputBudget,
  estimatedTokens,
  isRunning,
  omSegment,
}: ContextUsageMeterProps) => {
  const key = threadKey ?? 'active';
  const usage = useContextUsageStore((s) => s.usageByThread[key]);
  // Run-start prompt breakdown (or the explicit invalid marker) recorded by the
  // app-shell writer with the SAME thread key contract as recordUsage.
  const breakdownState = useContextUsageStore((s) => s.breakdownByThread[key]);
  // In-flight run's billed step usage (BST-953 live tick) — added to the
  // durable cumulative figure until the run's own row lands and the settle
  // path clears it (see context-usage-store.ts).
  const recordedLiveRunUsage = useContextUsageStore((s) => s.liveRunUsageByThread[key]);
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear a pending hover-close timer on unmount.
  // biome-ignore lint/plugin: unmount-only timer cleanup — not a state-as-event-handler effect
  useEffect(
    () => () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    },
    []
  );

  // Render nothing when we have no denominator.
  if (!(contextWindow && effectiveInputBudget)) {
    return null;
  }

  const cancelScheduledClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const openNow = () => {
    cancelScheduledClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  // Server breakdown baseline (system instructions + task list + tool
  // definitions) — the categories the conversation walk cannot see. Only a
  // VALID breakdown contributes; the invalid marker stays display-only.
  const breakdown =
    breakdownState && !breakdownState.invalid ? breakdownState.breakdown : undefined;
  const breakdownBaselineTokens = breakdown
    ? breakdown.systemInstructionsTokens +
      (breakdown.taskListTokens ?? 0) +
      (breakdown.toolDefinitionsTokens ?? 0)
    : 0;
  const { isEstimated, usedTokens } = resolveDisplayedContextUsage({
    breakdownBaselineTokens,
    conversationEstimateTokens: conversationEstimate?.totalTokens ?? estimatedTokens ?? 0,
    exact: usage,
    isRunning: isRunning === true,
  });

  const state = resolveUsageState(usedTokens, effectiveInputBudget);
  const percentage = Math.min(100, (usedTokens / effectiveInputBudget) * 100);

  // Thread-total headline (BST-953): the overall billed figure — every
  // captured source (chat, subagents, OM) plus the in-flight run's live step
  // usage — is what the chip leads with; context-window occupancy stays on
  // the ring and inside the popover. Absent cumulative data (web / an
  // unhydrated thread) falls back to the context fraction.
  //
  // BST-1652: the sum is only "in-flight" while a run actually is. A run the
  // user switched away from mid-stream may never settle, stranding its partial
  // sum on that thread key. `isRunning` is the reader-side truth for the IDLE
  // half — no run, no live component — and it is derived, not swept, because a
  // sweeping effect only fires after paint (one frame of phantom tokens).
  // It is NOT the whole answer: the gate opens again the moment a NEW run
  // starts on that thread, so the writer resets the sum at run start
  // (`prepareRequestAndResetLiveUsage` in the app-shell usage ledger) — a real
  // event, not an effect. Both are required; neither covers the other's case.
  const liveRunUsage = isRunning === true ? recordedLiveRunUsage : undefined;
  const liveTokens = liveRunUsage ? liveRunUsage.inputTokens + liveRunUsage.outputTokens : 0;
  const trigger = resolveTriggerDisplay({
    cumulativeUsage,
    effectiveInputBudget,
    isEstimated,
    liveTokens,
    percentage,
    usedTokens,
  });

  return (
    <div
      className="mx-3 mt-1.5 mb-1 flex flex-col gap-0.5 text-xs"
      data-state={state}
      data-testid="context-usage-meter"
    >
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          {/* The gauge row is a ONE-TURN-LAG estimate of the next prompt's
              size (prev input + prev output). The denominator is
              effectiveInputBudget so the fraction and the ring fill tell the
              same story; the full model window lives in the popover + title. */}
          <button
            aria-label={trigger.ariaLabel}
            className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="context-usage-trigger"
            onBlur={scheduleClose}
            onFocus={openNow}
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
            title={`context ${formatCompact(usedTokens)} / ${formatCompact(effectiveInputBudget)} · model window ${formatTokenCount(contextWindow)}`}
            type="button"
          >
            <ContextRing isEstimated={isEstimated} percentage={percentage} state={state} />
            <span
              className={cn(
                'tabular-nums',
                state === 'critical'
                  ? 'text-destructive'
                  : state === 'warning'
                    ? 'text-warning'
                    : 'text-muted-foreground'
              )}
            >
              {trigger.primaryText}
            </span>
            {trigger.costText && (
              <span
                className="text-muted-foreground/70 tabular-nums"
                data-testid="context-usage-trigger-cost"
              >
                {trigger.costText}
              </span>
            )}
            {trigger.badge && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                {trigger.badge}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 p-3"
          data-testid="context-usage-popover"
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <ContextUsagePopoverContent
            breakdownState={breakdownState}
            contextWindow={contextWindow}
            conversationEstimate={conversationEstimate}
            cumulativeUsage={cumulativeUsage}
            effectiveInputBudget={effectiveInputBudget}
            estimatedTokens={estimatedTokens}
            isEstimated={isEstimated}
            liveRunUsage={liveRunUsage}
            omSegment={omSegment}
            percentage={percentage}
            usage={usage}
            usedTokens={usedTokens}
          />
        </PopoverContent>
      </Popover>

      {/* Critical trimming-risk notice — INLINE next to the ring, never hidden
          inside the hover popover (visibility rule). */}
      {state === 'critical' && (
        <p className="text-[11px] text-destructive/80" data-testid="context-usage-critical-notice">
          Approaching input budget; older messages may be trimmed.
        </p>
      )}
    </div>
  );
};

ContextUsageMeter.displayName = 'ContextUsageMeter';

/**
 * Wrapper that lives INSIDE the AssistantRuntimeProvider tree.
 * Computes a heuristic token estimate from the current thread messages via
 * useAuiState, then renders ContextUsageMeter with it.
 *
 * Kept separate from ContextUsageMeter so the base component stays testable
 * without an assistant-ui context.
 */
export interface ThreadContextMeterProps {
  contextWindow: number | undefined;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  effectiveInputBudget: number | undefined;
  omSegment?: OmMeterState | undefined;
  threadKey: string | undefined;
}

export const ThreadContextMeter = ({
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  omSegment,
  threadKey,
}: ThreadContextMeterProps) => {
  // Access all messages to build the full-part conversation walk. The walk is
  // computed on EVERY snapshot (memoized per settled message object in
  // context-estimate.ts), so the gauge moves live while a run streams instead
  // of freezing until the next exact finish.
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  const conversationEstimate = useMemo(() => estimateConversationTokens(messages), [messages]);

  return (
    <ContextUsageMeter
      contextWindow={contextWindow}
      conversationEstimate={conversationEstimate}
      {...(cumulativeUsage ? { cumulativeUsage } : {})}
      effectiveInputBudget={effectiveInputBudget}
      isRunning={isRunning}
      {...(omSegment ? { omSegment } : {})}
      threadKey={threadKey}
    />
  );
};

ThreadContextMeter.displayName = 'ThreadContextMeter';
