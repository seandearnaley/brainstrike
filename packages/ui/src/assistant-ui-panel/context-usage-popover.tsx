/**
 * ContextUsagePopoverContent — the "Context Usage" detail panel opened from the
 * compact ring row (see context-usage-meter.tsx). Holds everything that used to
 * render inline in the bordered meter card: the usage header, the segmented
 * breakdown list, the OM informational stats, and the cumulative tokens + cost
 * row. The critical windowing notice deliberately does NOT live here — a
 * warning must not hide inside a hover surface (it stays inline next to the
 * ring).
 */
import type {
  AssistantContextBreakdown,
  AssistantContextBreakdownState,
} from '@brainstrike/assistant-contract/context-breakdown';
import { createLogger } from '@brainstrike/utils/logger';
import {
  type CostEstimate,
  formatTokenCount,
  formatUsdCost,
} from '@brainstrike/utils/token-counting-heuristics';
import { cn } from '../lib/utils';
import type { CumulativeUsageDisplay, OmMeterState } from './context-usage-meter';
import type { ThreadTokenUsage } from './context-usage-store';

const logger = createLogger('ContextUsagePopover');

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
 * The Conversation row: prefers the server-measured wire figure, else the
 * client-side heuristic walk (present only before exact usage is recorded —
 * the walk is skipped once exact usage exists). Returns the row plus the token
 * value that participates in the Unattributed remainder, or null when neither
 * figure exists (memory-backed thread after exact usage — the conversation
 * lands in Unattributed rather than being zero-faked).
 */
function conversationRow(
  breakdown: AssistantContextBreakdown | undefined,
  estimatedTokens: number | undefined
): { row: BreakdownRow; tokens: number } | null {
  if (breakdown?.historyMessagesTokens !== undefined) {
    return {
      row: {
        label: 'Conversation',
        testId: 'context-usage-breakdown-conversation',
        value: `~${formatCompact(breakdown.historyMessagesTokens)}`,
      },
      tokens: breakdown.historyMessagesTokens,
    };
  }
  if (estimatedTokens !== undefined && estimatedTokens > 0) {
    return {
      row: {
        label: 'Conversation (estimated)',
        testId: 'context-usage-breakdown-conversation',
        value: `~${formatCompact(estimatedTokens)}`,
      },
      tokens: estimatedTokens,
    };
  }
  return null;
}

/**
 * "Unattributed" = exact last-turn input tokens minus every token category the
 * list displays (system instructions, task list, conversation). Shown ONLY once
 * exact usage exists — before that there is no exact total to attribute
 * against. Display math, not policy: a heuristic overshoot is clamped to 0
 * with a debug log, never rendered negative.
 */
function unattributedRow(
  breakdown: AssistantContextBreakdown,
  conversationTokens: number,
  usage: ThreadTokenUsage | undefined
): BreakdownRow | null {
  if (!usage) {
    return null;
  }
  const attributed =
    breakdown.systemInstructionsTokens + (breakdown.taskListTokens ?? 0) + conversationTokens;
  const remainder = usage.inputTokens - attributed;
  if (remainder < 0) {
    logger.debug('Context breakdown attribution exceeds exact input tokens; clamping to 0', {
      attributed,
      exactInputTokens: usage.inputTokens,
    });
  }
  return {
    label: 'Unattributed',
    testId: 'context-usage-breakdown-unattributed',
    value: `~${formatCompact(Math.max(0, remainder))}`,
  };
}

/**
 * Compose the segmented breakdown rows. With a server prompt breakdown the
 * categories are System instructions / Task list / Conversation / Attachments
 * plus the explicit Unattributed remainder once exact usage lands. Without one
 * (web local runtime, reload, pre-Phase-B server) the honest rows are the
 * client conversation estimate and the exact last-turn usage.
 */
function buildBreakdownRows(params: {
  breakdown: AssistantContextBreakdown | undefined;
  estimatedTokens: number | undefined;
  usage: ThreadTokenUsage | undefined;
}): BreakdownRow[] {
  const rows: BreakdownRow[] = [];
  const conversation = conversationRow(params.breakdown, params.estimatedTokens);

  if (params.breakdown) {
    rows.push({
      label: 'System instructions',
      testId: 'context-usage-breakdown-system',
      value: `~${formatCompact(params.breakdown.systemInstructionsTokens)}`,
    });
    if (params.breakdown.taskListTokens !== undefined) {
      rows.push({
        label: 'Task list',
        testId: 'context-usage-breakdown-task-list',
        value: `~${formatCompact(params.breakdown.taskListTokens)}`,
      });
    }
  }
  if (conversation) {
    rows.push(conversation.row);
  }
  if (params.breakdown && params.breakdown.attachmentsCount > 0) {
    rows.push({
      label: 'Attachments',
      testId: 'context-usage-breakdown-attachments',
      value: `${params.breakdown.attachmentsCount} attached`,
    });
  }
  if (params.breakdown) {
    const unattributed = unattributedRow(params.breakdown, conversation?.tokens ?? 0, params.usage);
    if (unattributed) {
      rows.push(unattributed);
    }
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
  /**
   * Parsed run-start prompt breakdown for this thread (session store), or the
   * explicit invalid marker for a malformed wire part. Absent on the web local
   * runtime (capability-absent), after a reload, and before the first hosted
   * run — the popover then falls back to the client conversation estimate.
   */
  breakdownState?: AssistantContextBreakdownState | undefined;
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
  breakdownState,
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
  const breakdownInvalid = breakdownState?.invalid === true;
  const rows = buildBreakdownRows({
    breakdown: breakdownState && !breakdownState.invalid ? breakdownState.breakdown : undefined,
    estimatedTokens,
    usage,
  });

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

      {/* Malformed wire part → surfaced honestly, never coerced into rows. */}
      {breakdownInvalid && (
        <p
          className="mt-1 text-[11px] text-destructive/80"
          data-testid="context-usage-breakdown-invalid"
        >
          Prompt breakdown unavailable (malformed data from the last run).
        </p>
      )}

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
