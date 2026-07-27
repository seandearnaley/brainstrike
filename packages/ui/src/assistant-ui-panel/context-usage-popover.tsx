/**
 * ContextUsagePopoverContent — the "Context Usage" detail panel opened from the
 * compact ring row (see context-usage-meter.tsx). Cursor-style anatomy
 * (BST-940): a "% full" header, a segmented capacity bar over the effective
 * input budget, and a color-keyed legend of category rows (System instructions,
 * Tool definitions, Task list, Conversation, Attachments, Unattributed) with
 * per-tool and conversation-split sub-rows, then the OM informational stats and
 * the cumulative tokens + cost row. The critical trimming-risk notice
 * deliberately does NOT live here — a warning must not hide inside a hover
 * surface (it stays inline next to the ring).
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
import type { ConversationTokenEstimate } from './context-estimate';
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
    case 'awaiting-observer':
      return {
        text: 'Observations on (Auto) — add a provider API key to start observing',
        tone: 'muted',
      };
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

/** Legend/segment color classes per category (shared by bar and swatches). */
const CATEGORY_COLORS = {
  conversation: 'bg-emerald-500/80',
  system: 'bg-violet-500/80',
  taskList: 'bg-amber-500/80',
  toolDefinitions: 'bg-sky-500/80',
  unattributed: 'bg-rose-400/70',
} as const;

type CategoryId = keyof typeof CATEGORY_COLORS;

interface BreakdownRow {
  colorClass?: string;
  label: string;
  testId: string;
  value: string;
}

interface CategorySegment {
  colorClass: string;
  id: CategoryId;
  tokens: number;
}

/** Sub-row cap: show the biggest consumers, aggregate the rest honestly. */
const MAX_SUB_ROWS = 5;

/**
 * The Conversation figure: prefers the server-measured wire figure (non-memory
 * transports), else the client full-part walk, else the legacy scalar estimate.
 * Returns null when nothing measurable exists (the conversation then lands in
 * Unattributed once exact usage exists, rather than being zero-faked).
 */
function conversationFigure(
  breakdown: AssistantContextBreakdown | undefined,
  conversationEstimate: ConversationTokenEstimate | undefined,
  estimatedTokens: number | undefined
): { estimated: boolean; tokens: number } | null {
  if (breakdown?.historyMessagesTokens !== undefined) {
    return { estimated: false, tokens: breakdown.historyMessagesTokens };
  }
  if (conversationEstimate && conversationEstimate.totalTokens > 0) {
    return { estimated: true, tokens: conversationEstimate.totalTokens };
  }
  if (estimatedTokens !== undefined && estimatedTokens > 0) {
    return { estimated: true, tokens: estimatedTokens };
  }
  return null;
}

/**
 * "Unattributed" = exact last-turn input tokens minus every token category the
 * list displays. Shown ONLY once exact usage exists — before that there is no
 * exact total to attribute against. Display math, not policy: a heuristic
 * overshoot is clamped to 0 with a debug log, never rendered negative.
 */
function unattributedTokens(
  breakdown: AssistantContextBreakdown,
  conversationTokens: number,
  usage: ThreadTokenUsage | undefined
): number | null {
  if (!usage) {
    return null;
  }
  const attributed =
    breakdown.systemInstructionsTokens +
    (breakdown.taskListTokens ?? 0) +
    (breakdown.toolDefinitionsTokens ?? 0) +
    conversationTokens;
  const remainder = usage.inputTokens - attributed;
  if (remainder < 0) {
    logger.debug('Context breakdown attribution exceeds exact input tokens; clamping to 0', {
      attributed,
      exactInputTokens: usage.inputTokens,
    });
  }
  return Math.max(0, remainder);
}

interface ComposedBreakdown {
  rows: BreakdownRow[];
  segments: CategorySegment[];
  subRowsByTestId: Record<string, BreakdownRow[]>;
}

interface BreakdownComposer {
  rows: BreakdownRow[];
  segments: CategorySegment[];
  subRowsByTestId: Record<string, BreakdownRow[]>;
}

function pushCategory(
  composer: BreakdownComposer,
  id: CategoryId,
  row: BreakdownRow,
  tokens: number
): void {
  composer.rows.push({ ...row, colorClass: CATEGORY_COLORS[id] });
  if (tokens > 0) {
    composer.segments.push({ colorClass: CATEGORY_COLORS[id], id, tokens });
  }
}

/** Cap a named-entry list to the top consumers plus an aggregated remainder row. */
function toTopEntrySubRows(
  entries: readonly { readonly name: string; readonly tokens: number }[],
  options: { labelPrefix: string; restTestId: string; testIdPrefix: string }
): BreakdownRow[] {
  const top = entries.slice(0, MAX_SUB_ROWS);
  const subRows = top.map((entry, index) => ({
    label: `${options.labelPrefix}${entry.name}`,
    testId: `${options.testIdPrefix}${index}`,
    value: `~${formatCompact(entry.tokens)}`,
  }));
  const restCount = entries.length - top.length;
  if (restCount > 0) {
    subRows.push({
      label: `${options.labelPrefix}+${restCount} more tools`,
      testId: options.restTestId,
      value: `~${formatCompact(
        entries.slice(MAX_SUB_ROWS).reduce((sum, entry) => sum + entry.tokens, 0)
      )}`,
    });
  }
  return subRows;
}

/** Server-measured prompt-composition categories (system / tool defs / task list). */
function composeServerCategories(
  composer: BreakdownComposer,
  breakdown: AssistantContextBreakdown
): void {
  pushCategory(
    composer,
    'system',
    {
      label: 'System instructions',
      testId: 'context-usage-breakdown-system',
      value: `~${formatCompact(breakdown.systemInstructionsTokens)}`,
    },
    breakdown.systemInstructionsTokens
  );
  if (breakdown.toolDefinitionsTokens !== undefined) {
    pushCategory(
      composer,
      'toolDefinitions',
      {
        label: 'Tool definitions',
        testId: 'context-usage-breakdown-tool-definitions',
        value: `~${formatCompact(breakdown.toolDefinitionsTokens)}`,
      },
      breakdown.toolDefinitionsTokens
    );
    if (breakdown.toolDefinitionsByTool && breakdown.toolDefinitionsByTool.length > 0) {
      composer.subRowsByTestId['context-usage-breakdown-tool-definitions'] = toTopEntrySubRows(
        breakdown.toolDefinitionsByTool,
        {
          labelPrefix: '',
          restTestId: 'context-usage-tooldef-rest',
          testIdPrefix: 'context-usage-tooldef-',
        }
      );
    }
  }
  if (breakdown.taskListTokens !== undefined) {
    pushCategory(
      composer,
      'taskList',
      {
        label: 'Task list',
        testId: 'context-usage-breakdown-task-list',
        value: `~${formatCompact(breakdown.taskListTokens)}`,
      },
      breakdown.taskListTokens
    );
  }
}

/** Conversation split sub-rows (you/assistant/reasoning/tools + per-tool). */
function toConversationSubRows(conversationEstimate: ConversationTokenEstimate): BreakdownRow[] {
  const splitRows: BreakdownRow[] = [];
  const split: [string, string, number][] = [
    ['You', 'context-usage-conv-user', conversationEstimate.userTextTokens],
    ['Assistant', 'context-usage-conv-assistant', conversationEstimate.assistantTextTokens],
    ['Reasoning', 'context-usage-conv-reasoning', conversationEstimate.reasoningTokens],
    ['Tool activity', 'context-usage-conv-tools', conversationEstimate.toolTokens],
  ];
  for (const [label, testId, tokens] of split) {
    if (tokens > 0) {
      splitRows.push({ label, testId, value: `~${formatCompact(tokens)}` });
    }
  }
  splitRows.push(
    ...toTopEntrySubRows(conversationEstimate.byTool, {
      labelPrefix: '· ',
      restTestId: 'context-usage-conv-tool-rest',
      testIdPrefix: 'context-usage-conv-tool-',
    })
  );
  return splitRows;
}

function composeConversationCategory(
  composer: BreakdownComposer,
  conversation: { estimated: boolean; tokens: number },
  conversationEstimate: ConversationTokenEstimate | undefined
): void {
  pushCategory(
    composer,
    'conversation',
    {
      label: conversation.estimated ? 'Conversation (estimated)' : 'Conversation',
      testId: 'context-usage-breakdown-conversation',
      value: `~${formatCompact(conversation.tokens)}`,
    },
    conversation.tokens
  );
  if (conversationEstimate && conversationEstimate.totalTokens > 0) {
    const splitRows = toConversationSubRows(conversationEstimate);
    if (splitRows.length > 0) {
      composer.subRowsByTestId['context-usage-breakdown-conversation'] = splitRows;
    }
  }
}

/**
 * Compose the legend rows + capacity-bar segments from the same figures so the
 * bar and the list can never disagree. Absent categories stay absent.
 */
function composeBreakdown(params: {
  breakdown: AssistantContextBreakdown | undefined;
  conversationEstimate: ConversationTokenEstimate | undefined;
  estimatedTokens: number | undefined;
  usage: ThreadTokenUsage | undefined;
}): ComposedBreakdown {
  const composer: BreakdownComposer = { rows: [], segments: [], subRowsByTestId: {} };
  const { breakdown, conversationEstimate } = params;
  const conversation = conversationFigure(breakdown, conversationEstimate, params.estimatedTokens);

  if (breakdown) {
    composeServerCategories(composer, breakdown);
  }
  if (conversation) {
    composeConversationCategory(composer, conversation, conversationEstimate);
  }

  const attachmentsCount =
    breakdown && breakdown.attachmentsCount > 0
      ? breakdown.attachmentsCount
      : (conversationEstimate?.attachmentsCount ?? 0);
  if (attachmentsCount > 0) {
    composer.rows.push({
      label: 'Attachments',
      testId: 'context-usage-breakdown-attachments',
      value: `${attachmentsCount} attached`,
    });
  }

  if (breakdown) {
    const unattributed = unattributedTokens(breakdown, conversation?.tokens ?? 0, params.usage);
    if (unattributed !== null) {
      pushCategory(
        composer,
        'unattributed',
        {
          label: 'Unattributed',
          testId: 'context-usage-breakdown-unattributed',
          value: `~${formatCompact(unattributed)}`,
        },
        unattributed
      );
    }
  }

  if (params.usage) {
    composer.rows.push({
      label: 'Provider-effective context',
      testId: 'context-usage-breakdown-exact',
      value: formatCompact(params.usage.inputTokens + params.usage.outputTokens),
    });
  }

  return composer;
}

interface CapacityBarProps {
  effectiveInputBudget: number;
  segments: readonly CategorySegment[];
}

/**
 * Segmented capacity bar over the effective input budget. Segments render in
 * legend order; the unfilled remainder is the muted track (free space). Widths
 * clamp so an over-budget estimate can never overflow the bar.
 */
const CapacityBar = ({ effectiveInputBudget, segments }: CapacityBarProps) => {
  if (segments.length === 0) {
    return null;
  }
  let remaining = 100;
  const widths = segments.map((segment) => {
    const raw = (segment.tokens / effectiveInputBudget) * 100;
    const width = Math.max(0.75, Math.min(raw, remaining));
    remaining = Math.max(0, remaining - width);
    return { ...segment, width };
  });
  return (
    <div
      aria-hidden="true"
      className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      data-testid="context-usage-bar"
    >
      {widths.map((segment) => (
        <div
          className={cn('h-full', segment.colorClass)}
          data-segment={segment.id}
          key={segment.id}
          style={{ width: `${segment.width}%` }}
        />
      ))}
    </div>
  );
};

CapacityBar.displayName = 'CapacityBar';

export interface ContextUsagePopoverContentProps {
  /**
   * Parsed run-start prompt breakdown for this thread (session store), or the
   * explicit invalid marker for a malformed wire part. Absent on the web local
   * runtime (capability-absent), after a reload, and before the first hosted
   * run — the popover then falls back to the client conversation estimate.
   */
  breakdownState?: AssistantContextBreakdownState | undefined;
  contextWindow: number;
  /** Full-part client walk (per-tool + conversation split sub-rows). */
  conversationEstimate?: ConversationTokenEstimate | undefined;
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
  conversationEstimate,
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
  const { rows, segments, subRowsByTestId } = composeBreakdown({
    breakdown: breakdownState && !breakdownState.invalid ? breakdownState.breakdown : undefined,
    conversationEstimate,
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

      {/* Segmented capacity bar — same figures as the legend rows below. */}
      <CapacityBar effectiveInputBudget={effectiveInputBudget} segments={segments} />

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
            <li className="flex flex-col gap-0.5" data-testid={row.testId} key={row.testId}>
              <span className="flex items-center justify-between gap-2 text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {row.colorClass && (
                    <span
                      aria-hidden="true"
                      className={cn('h-2 w-2 shrink-0 rounded-[3px]', row.colorClass)}
                    />
                  )}
                  {row.label}
                </span>
                <span className="tabular-nums">{row.value}</span>
              </span>
              {subRowsByTestId[row.testId] && (
                <ul className="ml-3.5 flex flex-col gap-px border-border/60 border-l pl-2">
                  {subRowsByTestId[row.testId]?.map((subRow) => (
                    <li
                      className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70"
                      data-testid={subRow.testId}
                      key={subRow.testId}
                    >
                      <span className="truncate">{subRow.label}</span>
                      <span className="shrink-0 tabular-nums">{subRow.value}</span>
                    </li>
                  ))}
                </ul>
              )}
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
