/**
 * ContextUsagePopoverContent — the "Context Usage" detail panel opened from the
 * compact ring row (see context-usage-meter.tsx). Holds everything that used to
 * render inline in the bordered meter card: the usage header, the segmented
 * breakdown list, the OM informational stats, and the cumulative tokens + cost
 * row. The critical windowing notice deliberately does NOT live here — a
 * warning must not hide inside a hover surface (it stays inline next to the
 * ring).
 */
import {
  type CostEstimate,
  formatTokenCount,
  formatUsdCost,
} from '@brainstrike/utils/token-counting-heuristics';
import { cn } from '../lib/utils';
import type { CumulativeUsageDisplay, OmMeterState } from './context-usage-meter';
import type { ThreadTokenUsage } from './context-usage-store';

/** Strip the trailing " tokens" suffix from formatTokenCount output for compact display. */
export function formatCompact(count: number): string {
  return formatTokenCount(count).replace(' tokens', '');
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
 * Renders the OM portion of the panel as INFORMATIONAL active/buffered/progress
 * stats for the `stats` state, or an honest one-line note for every
 * other state (never zeros). The observation is deliberately NOT drawn as a
 * budget segment — it does not consume this turn's input budget (see OmMeterState
 * doc in context-usage-meter.tsx).
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

interface BreakdownRow {
  label: string;
  testId: string;
  value: string;
}

/**
 * Compose the segmented breakdown rows. Until the server-side prompt breakdown
 * lands (Phase B), the honest rows are the client-side conversation estimate
 * (present only before exact usage is recorded — the estimate walk is skipped
 * once exact usage exists) and the exact last-turn usage.
 */
function buildBreakdownRows(params: {
  estimatedTokens: number | undefined;
  usage: ThreadTokenUsage | undefined;
}): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  if (params.estimatedTokens !== undefined && params.estimatedTokens > 0) {
    rows.push({
      label: 'Conversation (estimated)',
      testId: 'context-usage-breakdown-conversation',
      value: `~${formatCompact(params.estimatedTokens)}`,
    });
  }
  if (params.usage) {
    rows.push({
      label: 'Exact usage last turn',
      testId: 'context-usage-breakdown-exact',
      value: formatCompact(params.usage.inputTokens + params.usage.outputTokens),
    });
  }
  return rows;
}

export interface ContextUsagePopoverContentProps {
  contextWindow: number;
  cumulativeUsage?: CumulativeUsageDisplay | undefined;
  effectiveInputBudget: number;
  estimatedTokens?: number | undefined;
  isEstimated: boolean;
  omSegment?: OmMeterState | undefined;
  percentage: number;
  usage?: ThreadTokenUsage | undefined;
  usedTokens: number;
}

export const ContextUsagePopoverContent = ({
  contextWindow,
  cumulativeUsage,
  effectiveInputBudget,
  estimatedTokens,
  isEstimated,
  omSegment,
  percentage,
  usage,
  usedTokens,
}: ContextUsagePopoverContentProps) => {
  const rows = buildBreakdownRows({ estimatedTokens, usage });

  return (
    <div className="flex flex-col gap-1 text-xs">
      {/* Header: percent-full + used/budget fraction. The denominator is the
          effective input budget (contextWindow − output reservation); the full
          model window is on the line below so neither number is lost. */}
      <p className="font-medium tabular-nums" data-testid="context-usage-popover-header">
        {Math.round(percentage)}% full · {formatCompact(usedTokens)}
        {isEstimated ? ' (estimated)' : ''} / {formatTokenCount(effectiveInputBudget)}
      </p>
      <p
        className="text-[11px] text-muted-foreground/80"
        data-testid="context-usage-popover-window"
      >
        model window {formatTokenCount(contextWindow)}
      </p>

      {rows.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="context-usage-breakdown">
          {rows.map((row) => (
            <li
              className="flex items-center justify-between gap-2 text-muted-foreground"
              data-testid={row.testId}
              key={row.testId}
            >
              <span>{row.label}</span>
              <span className="tabular-nums">{row.value}</span>
            </li>
          ))}
        </ul>
      )}

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
    </div>
  );
};

ContextUsagePopoverContent.displayName = 'ContextUsagePopoverContent';
