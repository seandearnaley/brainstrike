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
 *   critical ≥ 90% → shows the windowing notice INLINE (a warning must not
 *   hide inside a hover surface)
 */
import { useAuiState } from '@assistant-ui/react';
import {
  type CostEstimate,
  countTokensHeuristic,
  formatTokenCount,
} from '@brainstrike/utils/token-counting-heuristics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { getMessageParts } from './assistant-run-timeline';
import { ContextRing, type ContextRingState } from './context-ring';
import { ContextUsagePopoverContent, formatCompact } from './context-usage-popover';
import { useContextUsageStore } from './context-usage-store';

/**
 * Durable cumulative usage for the active thread, resolved upstream (tokens +
 * a discriminated cost). Distinct from the one-turn-lag gauge: this is the
 * running captured total persisted across reloads. `cost` is never $0 for an
 * unavailable price, and captured-only totals are visibly qualified as estimates.
 */
export interface CumulativeUsageDisplay {
  readonly cost: CostEstimate;
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
export type OmMeterState =
  | { readonly kind: 'chat-only' }
  | { readonly kind: 'inactive' }
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
   * Durable cumulative usage for this thread (running token total + cost),
   * hydrated from the DB. Absent on web / before hydration → the cumulative line
   * is not shown in the popover (the last-turn gauge still renders).
   */
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  /** Effective input budget (contextWindow − output reservation). Meter is hidden when absent. */
  effectiveInputBudget: number | undefined;
  /** Heuristic token estimate to display before exact usage is recorded. */
  estimatedTokens?: number | undefined;
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

export const ContextUsageMeter = ({
  threadKey,
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  estimatedTokens,
  omSegment,
}: ContextUsageMeterProps) => {
  const key = threadKey ?? 'active';
  const usage = useContextUsageStore((s) => s.usageByThread[key]);
  // Run-start prompt breakdown (or the explicit invalid marker) recorded by the
  // app-shell writer with the SAME thread key contract as recordUsage.
  const breakdownState = useContextUsageStore((s) => s.breakdownByThread[key]);
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

  // Determine the token count and whether it's an estimate.
  let usedTokens: number;
  let isEstimated: boolean;

  if (usage) {
    usedTokens = usage.inputTokens + usage.outputTokens;
    isEstimated = false;
  } else if (estimatedTokens !== undefined && estimatedTokens > 0) {
    usedTokens = estimatedTokens;
    isEstimated = true;
  } else {
    // No usage and no estimate — still show a zero gauge so the denominator is visible.
    usedTokens = 0;
    isEstimated = false;
  }

  const state = resolveUsageState(usedTokens, effectiveInputBudget);
  const percentage = Math.min(100, (usedTokens / effectiveInputBudget) * 100);

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
            aria-label={`Context usage: ${Math.round(percentage)}% of input budget${isEstimated ? ' (estimated)' : ''}`}
            className="flex w-fit items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="context-usage-trigger"
            onBlur={scheduleClose}
            onFocus={openNow}
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
            title={`model window ${formatTokenCount(contextWindow)}`}
            type="button"
          >
            <ContextRing isEstimated={isEstimated} percentage={percentage} state={state} />
            <span
              className={cn(
                'tabular-nums',
                state === 'critical'
                  ? 'text-destructive'
                  : state === 'warning'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-muted-foreground'
              )}
            >
              {formatCompact(usedTokens)} / {formatCompact(effectiveInputBudget)}
            </span>
            {isEstimated && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                est.
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
            cumulativeUsage={cumulativeUsage}
            effectiveInputBudget={effectiveInputBudget}
            estimatedTokens={estimatedTokens}
            isEstimated={isEstimated}
            omSegment={omSegment}
            percentage={percentage}
            usage={usage}
            usedTokens={usedTokens}
          />
        </PopoverContent>
      </Popover>

      {/* Critical windowing notice — INLINE next to the ring, never hidden
          inside the hover popover (visibility rule). */}
      {state === 'critical' && (
        <p className="text-[11px] text-destructive/80" data-testid="context-usage-critical-notice">
          Older messages are summarized out of context.
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
  // Access all messages to build a heuristic token estimate.
  const messages = useAuiState((s) => s.thread.messages);
  // Exact usage for this thread — when present, skip the message walk entirely
  // (ContextUsageMeter prefers exact usage over the estimate anyway).
  const usage = useContextUsageStore((s) => s.usageByThread[threadKey ?? 'active']);

  const estimatedTokens = useMemo(() => {
    if (usage) {
      return; // exact usage present — skip the walk entirely
    }
    let total = 0;
    for (const msg of messages) {
      // getMessageParts reads `content` first (the real assistant-ui shape),
      // then falls back to `parts` — matching the canonical resolution in
      // assistant-run-timeline.tsx. Using `parts` directly always returned
      // undefined for real useAuiState messages, so the estimate was always
      // skipped and the "estimated" badge never appeared in the live app.
      const parts = getMessageParts(msg);
      for (const part of parts) {
        const p = part as { type?: string; text?: string };
        if (p.type === 'text' && typeof p.text === 'string') {
          total += countTokensHeuristic(p.text);
        }
      }
    }
    return total > 0 ? total : undefined;
  }, [usage, messages]);

  return (
    <ContextUsageMeter
      contextWindow={contextWindow}
      {...(cumulativeUsage ? { cumulativeUsage } : {})}
      effectiveInputBudget={effectiveInputBudget}
      estimatedTokens={estimatedTokens}
      {...(omSegment ? { omSegment } : {})}
      threadKey={threadKey}
    />
  );
};

ThreadContextMeter.displayName = 'ThreadContextMeter';
