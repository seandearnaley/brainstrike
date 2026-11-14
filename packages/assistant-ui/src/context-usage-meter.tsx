/**
 * ContextUsageMeter — compact context gauge shown above the composer.
 *
 * One row: an SVG donut ring (context-ring.tsx) + a "used / budget" fraction.
 * The row is a popover trigger that opens, on explicit activation only (click,
 * Enter or Space), the "Context Usage" detail panel (context-usage-popover.tsx)
 * holding the breakdown list and cumulative tokens + cost. Sources
 * usage from the zustand store (exact, post-turn) and falls back to a heuristic
 * estimate when no exact value has been recorded yet.
 *
 * Threshold states (fraction of effectiveInputBudget):
 *   ok      < 75%
 *   warning ≥ 75%
 *   critical ≥ 90% → shows the trimming-risk notice INLINE (a warning must not
 *   hide inside the popover)
 */
import { useAuiState } from '@assistant-ui/react';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import {
  type CostEstimate,
  countTokensHeuristic,
  formatTokenCount,
  formatUsdCost,
} from '@brainstrike/tokenization';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { useEffect } from 'react';
import {
  type ConversationTokenEstimate,
  estimateConversationTokens,
  resolveDisplayedContextUsage,
} from './context-estimate';
import { useContextMapLink } from './context-map-link-context';
import { ContextRing, type ContextRingState } from './context-ring';
import { ContextUsagePopoverContent } from './context-usage-popover';
import { useContextUsageStore } from './context-usage-store';
import { formatCompact } from './format-compact-token-count';
import { fileWindowTokens, threadContextAt } from './thread-context-fold';
import { useThreadContextStore } from './thread-context-store';

/** One model's usage and cost within a source; null cost when unpriced. */
interface CumulativeModelUsage {
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly provider: string;
}

/** One source's share of the thread total (BST-953). */
interface CumulativeSourceUsage {
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly kind: AssistantRunUsageKind;
  /** Its models, costliest first. */
  readonly models: readonly CumulativeModelUsage[];
  readonly outputTokens: number;
}

/**
 * Durable thread-total usage, resolved upstream (structural mirror of the
 * app-shell resolver's shape — dependency direction app-shell → ui). Distinct
 * from the one-turn-lag context gauge: this is the running captured billing
 * total persisted across reloads, broken down by source (chat, subagents,
 * compaction summaries, …) with cache-class totals and the net caching savings. `cost` is never $0
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
   * hydrated from the DB. Absent before hydration → the cumulative line
   * is not shown in the popover (the last-turn gauge still renders).
   */
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  /**
   * Heuristic size of the unsent composer draft. Shown as a "+N tokens" hint
   * beside the figure, and it can raise the warning before the draft is sent;
   * the ring and the recorded figure stay the conversation's own.
   */
  draftTokens?: number | undefined;
  /** Effective input budget (contextWindow − output reservation). Meter is hidden when absent. */
  effectiveInputBudget: number | undefined;
  /** Heuristic token estimate to display before exact usage is recorded. */
  estimatedTokens?: number | undefined;
  /** True while a run streams — the gauge shows the LIVE estimate (flagged). */
  isRunning?: boolean | undefined;
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

const STATE_TEXT_CLASS: Readonly<Record<ContextRingState, string>> = {
  critical: 'text-destructive',
  ok: 'text-muted-foreground',
  warning: 'text-warning',
};

/** The unsent draft's size beside the figure, coloured by what sending it would bring. */
function DraftHint({
  projectedState,
  text,
}: {
  readonly projectedState: ContextRingState;
  readonly text: string;
}) {
  return (
    <span
      className={cn('tabular-nums', STATE_TEXT_CLASS[projectedState])}
      data-testid="context-usage-draft"
      title="The unsent draft's estimated size"
    >
      {text}
    </span>
  );
}

/**
 * Trimming-risk notice, INLINE next to the ring, never hidden inside the
 * popover (visibility rule). A draft that would cross the line warns before
 * it is sent.
 */
function BudgetNotice({
  projectedState,
  state,
}: {
  readonly projectedState: ContextRingState;
  readonly state: ContextRingState;
}) {
  if (projectedState !== 'critical') {
    return null;
  }
  return (
    <p className="bs-composer-context-notice" data-testid="context-usage-critical-notice">
      {state === 'critical'
        ? 'Approaching input budget; older messages may be trimmed.'
        : 'Sending this draft approaches the input budget; older messages may be trimmed.'}
    </p>
  );
}

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
  draftTokens = 0,
  effectiveInputBudget,
  estimatedTokens,
  isRunning,
}: ContextUsageMeterProps) => {
  const key = threadKey ?? 'active';
  const usage = useContextUsageStore((s) => s.usageByThread[key]);
  // Run-start prompt breakdown (or the explicit invalid marker) recorded by the
  // app-shell writer with the SAME thread key contract as recordUsage.
  const breakdownState = useContextUsageStore((s) => s.breakdownByThread[key]);
  // The thread context fold's latest window (ADR-0021): the same figure the
  // Context tab's header shows. Absent where no committed fold exists.
  const contextRecord = useThreadContextStore((s) => s.byThread[key]);
  const workspaceFileTokens = contextRecord
    ? fileWindowTokens(threadContextAt(contextRecord.snapshot, contextRecord.branchRunIds))
    : undefined;
  const contextMapLink = useContextMapLink();
  // In-flight run's billed step usage (BST-953 live tick) — added to the
  // durable cumulative figure until the run's own row lands and the settle
  // path clears it (see context-usage-store.ts).
  const recordedLiveRunUsage = useContextUsageStore((s) => s.liveRunUsageByThread[key]);
  const isSettlingRunUsage = useContextUsageStore((s) => s.settlingRunUsageByThread[key] === true);

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
  // Publish the ring's figure for the Context tab's header (one writer), only
  // while the ring itself renders.
  const recordRing = useThreadContextStore((s) => s.recordRing);
  // biome-ignore lint/plugin: publishes a figure only this meter can compute to the shared store
  useEffect(() => {
    if (contextWindow && effectiveInputBudget) {
      recordRing(key, { budgetTokens: effectiveInputBudget, isEstimated, usedTokens });
    }
  }, [contextWindow, effectiveInputBudget, isEstimated, key, recordRing, usedTokens]);

  // Render nothing when we have no denominator.
  if (!(contextWindow && effectiveInputBudget)) {
    return null;
  }

  const state = resolveUsageState(usedTokens, effectiveInputBudget);
  const percentage = Math.min(100, (usedTokens / effectiveInputBudget) * 100);
  // What sending the draft would bring the context to: it warns before the send.
  const projectedState = resolveUsageState(usedTokens + draftTokens, effectiveInputBudget);
  const draftText = draftTokens > 0 ? `+${formatTokenCount(draftTokens)}` : undefined;

  // Thread-total headline (BST-953): the overall billed figure — every
  // captured source plus the in-flight run's live step
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
  //
  // `isRunning` alone is also too NARROW at the other end: it goes false at
  // stream finish, while the writer holds the live sum until the durable row is
  // absorbed by a refreshed cumulative. Gating on it alone drops the whole run
  // from the headline for that window and jumps it back when the refresh lands
  // — the dip the writer's ordering exists to prevent, on every run rather than
  // in an edge case. `settlingRunUsageByThread` is the writer saying "this sum
  // is still mine"; a run the user walked away from never enters it.
  const liveRunUsage = isRunning === true || isSettlingRunUsage ? recordedLiveRunUsage : undefined;
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
    // Laid out by the composer toolbar (`.bs-composer-context`): the trigger
    // takes the row's far end and the critical notice wraps beneath it.
    <div className="bs-composer-context" data-state={state} data-testid="context-usage-meter">
      {/* Opens on activation, never on hover or focus: a pointer left resting
          where a layout shift moves the trigger would otherwise hold the panel
          open over the composer and the controls beneath it. */}
      <Popover>
        <PopoverTrigger asChild>
          {/* The gauge row is a ONE-TURN-LAG estimate of the next prompt's
              size (prev input + prev output). The denominator is
              effectiveInputBudget so the fraction and the ring fill tell the
              same story; the full model window lives in the popover + title. */}
          <button
            aria-label={draftText ? `${trigger.ariaLabel}; draft ${draftText}` : trigger.ariaLabel}
            className="bs-composer-chip bs-composer-context-trigger"
            data-testid="context-usage-trigger"
            title={`context ${formatCompact(usedTokens)} / ${formatCompact(effectiveInputBudget)} · model window ${formatTokenCount(contextWindow)}`}
            type="button"
          >
            <ContextRing isEstimated={isEstimated} percentage={percentage} state={state} />
            <span className={cn('tabular-nums', STATE_TEXT_CLASS[state])}>
              {trigger.primaryText}
            </span>
            {draftText && <DraftHint projectedState={projectedState} text={draftText} />}
            {trigger.costText && (
              <span
                className="text-muted-foreground tabular-nums"
                data-testid="context-usage-trigger-cost"
              >
                {trigger.costText}
              </span>
            )}
            {trigger.badge && (
              <span className="bs-composer-context-badge bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
                {trigger.badge}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[min(40rem,var(--radix-popover-content-available-height))] w-96 overflow-y-auto p-3"
          data-testid="context-usage-popover"
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
            onOpenContextMap={contextMapLink?.openContextMap}
            percentage={percentage}
            usage={usage}
            usedTokens={usedTokens}
            workspaceFileTokens={workspaceFileTokens}
          />
        </PopoverContent>
      </Popover>

      <BudgetNotice projectedState={projectedState} state={state} />
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
  threadKey: string | undefined;
}

export const ThreadContextMeter = ({
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  threadKey,
}: ThreadContextMeterProps) => {
  // Access all messages to build the full-part conversation walk. The walk is
  // computed on EVERY snapshot (memoized per settled message object in
  // context-estimate.ts), so the gauge moves live while a run streams instead
  // of freezing until the next exact finish.
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // The selector returns the count, so typing re-renders the meter only when
  // the estimate moves (the same chars/4 heuristic as the conversation walk).
  const draftTokens = useAuiState((s) => countTokensHeuristic(s.composer.text));

  const conversationEstimate = estimateConversationTokens(messages);

  return (
    <ContextUsageMeter
      contextWindow={contextWindow}
      conversationEstimate={conversationEstimate}
      {...(cumulativeUsage ? { cumulativeUsage } : {})}
      draftTokens={draftTokens}
      effectiveInputBudget={effectiveInputBudget}
      isRunning={isRunning}
      threadKey={threadKey}
    />
  );
};

ThreadContextMeter.displayName = 'ThreadContextMeter';
