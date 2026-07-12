/**
 * ContextUsageMeter — thread context usage bar shown above the composer.
 *
 * Displays tokens used vs. the effective input budget (≤ contextWindow - output
 * reservation). Sources usage from the zustand store (exact, post-turn) and falls
 * back to a heuristic estimate when no exact value has been recorded yet.
 *
 * Threshold states (fraction of effectiveInputBudget):
 *   ok      < 75%
 *   warning ≥ 75%
 *   critical ≥ 90% → shows windowing notice
 */
import { useAuiState } from '@assistant-ui/react';
import {
  type CostEstimate,
  countTokensHeuristic,
  formatTokenCount,
  formatUsdCost,
} from '@brainstrike/utils/token-counting-heuristics';
import { useMemo } from 'react';
import { cn } from '../lib/utils';
import { getMessageParts } from './assistant-run-timeline';
import { useContextUsageStore } from './context-usage-store';

/**
 * Durable cumulative usage for the active thread, resolved upstream (tokens +
 * a discriminated cost). Distinct from the one-turn-lag bar above: this is the
 * running captured total persisted across reloads. `cost` is never $0 for an
 * unavailable price, and captured-only totals are visibly qualified as estimates.
 */
export interface CumulativeUsageDisplay {
  readonly cost: CostEstimate;
  readonly totalTokens: number;
}

/** Resolve a cost estimate to its display string (never $0 for unavailable). */
function costLabel(cost: CostEstimate): string {
  if (cost.available) {
    const amount = formatUsdCost(cost.usdAmount);
    return cost.provenance === 'captured-usage-estimate' ? `captured usage est. ${amount}` : amount;
  }
  return 'cost unavailable';
}

/**
 * Resolved observational-memory (OM) state for the active thread. Produced by the
 * app-shell resolver (assistant-om-segment.ts) and rendered as INFORMATIONAL
 * stats next to the chat-vs-budget bar — the observation is NOT a budget segment
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
   * is not shown (the last-turn bar still renders).
   */
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  /** Effective input budget (contextWindow − output reservation). Meter is hidden when absent. */
  effectiveInputBudget: number | undefined;
  /** Heuristic token estimate to display before exact usage is recorded. */
  estimatedTokens?: number | undefined;
  /**
   * Resolved OM state for the active thread, rendered as INFORMATIONAL stats
   * below the chat-vs-budget bar (observed tokens + compaction saved) — NOT a
   * budget segment. Absent → no OM line (desktop before the first resolve).
   * Desktop-only: on web the resolver supplies `{ kind: 'chat-only' }` so the
   * stats are hidden honestly. Prop name kept as `omSegment` for call-site
   * stability across the panel layers.
   */
  omSegment?: OmMeterState | undefined;
  /** Thread key — MUST match the key used by recordUsage writers (same as threadKey prop on AssistantUiPanel). Falls back to 'active'. */
  threadKey?: string | undefined;
}

type UsageState = 'ok' | 'warning' | 'critical';

function resolveUsageState(used: number, effectiveInputBudget: number): UsageState {
  const ratio = used / effectiveInputBudget;
  if (ratio >= 0.9) {
    return 'critical';
  }
  if (ratio >= 0.75) {
    return 'warning';
  }
  return 'ok';
}

/** Strip the trailing " tokens" suffix from formatTokenCount output for compact display. */
function formatCompact(count: number): string {
  return formatTokenCount(count).replace(' tokens', '');
}

/**
 * Short note + testid for the non-`stats` OM states (honest, never a 0). Returns
 * null for `loading` so the OM line stays quiet during the initial fetch / a
 * thread switch instead of flashing the empty state.
 */
function omNote(state: OmMeterState): { text: string; tone: 'muted' | 'error' } | null {
  switch (state.kind) {
    case 'chat-only':
      return { text: 'Observations available on desktop', tone: 'muted' };
    case 'inactive':
      return { text: 'OM inactive', tone: 'muted' };
    case 'empty':
      return { text: 'No observations yet', tone: 'muted' };
    case 'error':
      return { text: 'Observations unavailable', tone: 'error' };
    default:
      // 'loading' and 'stats' are handled by OmMeterSection, not as a note.
      return null;
  }
}

interface OmMeterSectionProps {
  state: OmMeterState;
}

/**
 * Renders the OM portion of the meter as INFORMATIONAL active/buffered/progress
 * stats for the `stats` state, or an honest one-line note for every
 * other state (never zeros). The observation is deliberately NOT drawn as a
 * budget segment — it does not consume this turn's input budget (see OmMeterState
 * doc). Extracted so ContextUsageMeter stays under the cognitive-complexity budget.
 */
const OmMeterSection = ({ state }: OmMeterSectionProps) => {
  if (state.kind === 'stats') {
    return (
      <div
        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground/70"
        data-testid="context-usage-om-stats"
      >
        {state.observationTokens > 0 && (
          <span className="tabular-nums" data-testid="context-usage-om-active">
            Active OM: ~{formatCompact(state.observationTokens)} tokens
          </span>
        )}
        {state.bufferedObservationTokens > 0 && (
          <span className="tabular-nums" data-testid="context-usage-om-buffered">
            Buffered OM: ~{formatCompact(state.bufferedObservationTokens)} tokens
          </span>
        )}
        <span className="tabular-nums" data-testid="context-usage-om-progress">
          Messages: ~{formatCompact(state.pendingMessageTokens)} /{' '}
          {formatCompact(state.messageTokenThreshold)} toward activation
        </span>
        {state.compactionSavedTokens > 0 && (
          <span className="tabular-nums" data-testid="context-usage-om-compaction">
            Reflection saved ~{formatCompact(state.compactionSavedTokens)} tokens
          </span>
        )}
      </div>
    );
  }

  const note = omNote(state);
  if (!note) {
    return null;
  }
  return (
    <p
      className={cn(
        'mt-1.5 text-[11px]',
        note.tone === 'error' ? 'text-destructive/80' : 'text-muted-foreground/70'
      )}
      data-testid="context-usage-om-note"
    >
      {note.text}
    </p>
  );
};

OmMeterSection.displayName = 'OmMeterSection';

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

  // Render nothing when we have no denominator.
  if (!(contextWindow && effectiveInputBudget)) {
    return null;
  }

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
    // No usage and no estimate — still show a zero meter so the denominator is visible.
    usedTokens = 0;
    isEstimated = false;
  }

  const state = resolveUsageState(usedTokens, effectiveInputBudget);
  const percentage = Math.min(100, (usedTokens / effectiveInputBudget) * 100);

  return (
    <div
      className={cn(
        'mx-3 mt-1.5 mb-1 rounded-lg border px-3 py-1.5 text-xs',
        state === 'critical'
          ? 'border-destructive/40 bg-destructive/5'
          : state === 'warning'
            ? 'border-amber-500/30 bg-amber-50/30 dark:bg-amber-950/20'
            : 'border-border/50 bg-muted/20'
      )}
      data-state={state}
      data-testid="context-usage-meter"
      // The full model context window is surfaced here so the information is
      // not lost while the fraction shows the effective input budget.
      title={`model window ${formatTokenCount(contextWindow)}`}
    >
      {/* Last-turn token counts row — this bar is a ONE-TURN-LAG estimate of
          the next prompt's size (prev input + prev output), so it is labelled
          "last turn" to disambiguate it from the cumulative line below. The
          denominator is effectiveInputBudget so the text fraction and the bar
          fill tell the same story. The full contextWindow is visible in the
          title above. */}
      <div className="flex items-center justify-between gap-2">
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
          <span className="mr-1 text-[10px] text-muted-foreground/60 uppercase tracking-wide">
            last turn
          </span>
          {formatCompact(usedTokens)} / {formatTokenCount(effectiveInputBudget)}
        </span>
        {isEstimated && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground/70 uppercase tracking-wide">
            estimated
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-border/50">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-300',
            state === 'critical'
              ? 'bg-destructive/70'
              : state === 'warning'
                ? 'bg-amber-500/70'
                : 'bg-muted-foreground/40'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* OM informational stats (observed tokens + compaction saved), or an
          honest note for the other states. NOT a budget segment — the
          observation does not consume this turn's input budget. Desktop-only:
          web supplies { kind: 'chat-only' } so the stats are hidden, never
          zeros. */}
      {omSegment && <OmMeterSection state={omSegment} />}

      {/* Cumulative durable usage + cost. Only shown when hydrated from the DB
          (desktop). Cost renders via formatUsdCost, or the literal "cost
          unavailable" for the available:false branch — NEVER $0. */}
      {cumulativeUsage && (
        <div
          className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground/80"
          data-testid="context-usage-cumulative"
        >
          <span className="tabular-nums">
            <span className="mr-1 text-[10px] text-muted-foreground/60 uppercase tracking-wide">
              cumulative
            </span>
            {formatTokenCount(cumulativeUsage.totalTokens)}
          </span>
          <span className="tabular-nums" data-testid="context-usage-cost">
            {costLabel(cumulativeUsage.cost)}
          </span>
        </div>
      )}

      {/* Critical windowing notice */}
      {state === 'critical' && (
        <p className="mt-1 text-[11px] text-destructive/80">
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
