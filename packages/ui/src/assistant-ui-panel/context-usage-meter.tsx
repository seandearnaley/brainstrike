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
import { type FC, useMemo } from 'react';
import { cn } from '../lib/utils';
import { getMessageParts } from './assistant-run-timeline';
import { useContextUsageStore } from './context-usage-store';

/**
 * Durable cumulative usage for the active thread, resolved upstream (tokens +
 * a discriminated cost). Distinct from the one-turn-lag bar above: this is the
 * running total persisted across reloads. `cost` is never $0 for an unavailable
 * price — the `available: false` branch renders "cost unavailable".
 */
export interface CumulativeUsageDisplay {
  readonly cost: CostEstimate;
  readonly totalTokens: number;
}

/** Resolve a cost estimate to its display string (never $0 for unavailable). */
function costLabel(cost: CostEstimate): string {
  if (cost.available) {
    return formatUsdCost(cost.usdAmount);
  }
  return 'cost unavailable';
}

/**
 * Resolved tri-segment (chat / observation / free) meter state for the active
 * thread's observational memory (OM). Produced by the app-shell resolver
 * (assistant-om-segment.ts) and rendered here. Each non-`segments` variant is an
 * HONEST state — never a fabricated 0:
 *   chat-only → web (no durable OM persistence); segments collapse to chat.
 *   inactive  → OM disabled in settings.
 *   empty     → no OM row yet (first turn).
 *   error     → malformed OM row (strict parse failed upstream).
 *   segments  → live values; `overBudget` shows a negative `freeTokens` honestly.
 */
export type OmMeterState =
  | { readonly kind: 'chat-only' }
  | { readonly kind: 'inactive' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly reason: string }
  | {
      readonly kind: 'segments';
      readonly chatTokens: number;
      readonly observationTokens: number;
      readonly freeTokens: number;
      readonly overBudget: boolean;
      readonly compactionSavedTokens: number;
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
   * Resolved OM tri-segment state for the active thread. Absent → the OM bar is
   * not rendered (desktop before the first resolve). Desktop-only: on web the
   * resolver supplies `{ kind: 'chat-only' }` so the segments collapse honestly.
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

/** Short note + testid for the non-`segments` OM states (honest, never a 0). */
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
      return null;
  }
}

interface OmSegmentBarProps {
  effectiveInputBudget: number;
  state: Extract<OmMeterState, { kind: 'segments' }>;
}

/**
 * Unified chat / observation / free segmented bar denominated against the SAME
 * effectiveInputBudget as the last-turn bar. Widths use the budget as the
 * denominator so the three segments and the free remainder tell one story. When
 * over budget the bar fills to 100% (chat+observation clamp) and the free
 * segment is replaced by an honest "over budget" marker — the negative free is
 * surfaced in text, never hidden.
 */
const OmSegmentBar: FC<OmSegmentBarProps> = ({ effectiveInputBudget, state }) => {
  const chatPct = Math.max(0, Math.min(100, (state.chatTokens / effectiveInputBudget) * 100));
  const observationPct = Math.max(
    0,
    Math.min(100 - chatPct, (state.observationTokens / effectiveInputBudget) * 100)
  );
  const freePct = Math.max(0, 100 - chatPct - observationPct);

  return (
    <div
      className="mt-1.5"
      data-over-budget={state.overBudget ? 'true' : 'false'}
      data-testid="context-usage-om-segments"
    >
      <div className="flex h-1 overflow-hidden rounded-full bg-border/50">
        <div className="h-full bg-muted-foreground/50" style={{ width: `${chatPct}%` }} />
        <div className="h-full bg-sky-500/60" style={{ width: `${observationPct}%` }} />
        <div
          className={cn('h-full', state.overBudget ? 'bg-destructive/50' : 'bg-emerald-500/30')}
          style={{ width: `${freePct}%` }}
        />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/80">
        <span className="tabular-nums">
          <span className="mr-1 inline-block size-1.5 rounded-full bg-muted-foreground/50 align-middle" />
          chat {formatCompact(state.chatTokens)}
        </span>
        <span className="tabular-nums">
          <span className="mr-1 inline-block size-1.5 rounded-full bg-sky-500/60 align-middle" />
          obs {formatCompact(state.observationTokens)}
        </span>
        {state.overBudget ? (
          <span className="text-destructive tabular-nums">
            over budget {formatCompact(Math.abs(state.freeTokens))}
          </span>
        ) : (
          <span className="tabular-nums">
            <span className="mr-1 inline-block size-1.5 rounded-full bg-emerald-500/40 align-middle" />
            free {formatCompact(state.freeTokens)}
          </span>
        )}
      </div>
    </div>
  );
};

OmSegmentBar.displayName = 'OmSegmentBar';

interface OmMeterSectionProps {
  effectiveInputBudget: number;
  state: OmMeterState;
}

/**
 * Renders the OM portion of the meter: the tri-segment bar + compaction stat for
 * an active row, or an honest one-line note for every other state (never zeros).
 * Extracted so ContextUsageMeter stays under the cognitive-complexity budget.
 */
const OmMeterSection: FC<OmMeterSectionProps> = ({ effectiveInputBudget, state }) => {
  if (state.kind === 'segments') {
    return (
      <>
        <OmSegmentBar effectiveInputBudget={effectiveInputBudget} state={state} />
        {state.compactionSavedTokens > 0 && (
          <p
            className="mt-1 text-[11px] text-muted-foreground/70"
            data-testid="context-usage-om-compaction"
          >
            Reflection saved ~{formatCompact(state.compactionSavedTokens)} tokens
          </p>
        )}
      </>
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

export const ContextUsageMeter: FC<ContextUsageMeterProps> = ({
  threadKey,
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  estimatedTokens,
  omSegment,
}) => {
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

      {/* OM tri-segment bar (chat / observation / free) + compaction stat, or an
          honest note for the non-segment states. Desktop-only: web supplies
          { kind: 'chat-only' } so the bar collapses to a note, never zeros. */}
      {omSegment && (
        <OmMeterSection effectiveInputBudget={effectiveInputBudget} state={omSegment} />
      )}

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

export const ThreadContextMeter: FC<ThreadContextMeterProps> = ({
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  omSegment,
  threadKey,
}) => {
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
