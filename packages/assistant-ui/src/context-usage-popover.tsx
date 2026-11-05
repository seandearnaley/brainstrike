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
import { resolveModelLabel } from '@brainstrike/assistant-contract/provider-registry';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import { createLogger } from '@brainstrike/logging';
import { type CostEstimate, formatTokenCount, formatUsdCost } from '@brainstrike/tokenization';
import { cn } from '@brainstrike/ui';
import { useAssistantDetailLevel } from './assistant-detail-level-store.ts';
import type { ConversationTokenEstimate } from './context-estimate';
import { MemoryDeveloperPanel } from './context-usage-memory-panel';
import type {
  CumulativeUsageDisplay,
  OmAwaitingObserverReason,
  OmMeterState,
} from './context-usage-meter';
import type { ThreadTokenUsage } from './context-usage-store';
import { formatCompact } from './format-compact-token-count';

const logger = createLogger('ContextUsagePopover');

/** A cost estimate's display string (never $0 for unavailable). */
function costLabel(cost: CostEstimate): string {
  return cost.available ? formatUsdCost(cost.usdAmount) : 'cost unavailable';
}

/** A subtotal's cost: cents from a cent up, two significant digits below it. */
function subtotalCostLabel(costUsd: number | null): string {
  if (costUsd === null) {
    return 'unpriced';
  }
  return costUsd === 0 || costUsd >= 0.01
    ? formatUsdCost(costUsd)
    : `$${Number(costUsd.toPrecision(2))}`;
}

/** Display label per usage source (BST-953). OM figures are local estimates. */
const SOURCE_LABELS: Record<AssistantRunUsageKind, string> = {
  chat: 'Chat',
  'compaction-summary': 'Compaction summaries',
  'om-observation': 'Memory observer (est.)',
  'om-reflection': 'Memory reflection (est.)',
  subagent: 'Subagents',
};

export interface CumulativeUsageSectionProps {
  cumulativeUsage: CumulativeUsageDisplay;
  readonly label?: string;
  /** In-flight run's billed step usage (live tick), not yet in the durable rows. */
  liveRunUsage?: ThreadTokenUsage | undefined;
}

type CumulativeSource = CumulativeUsageDisplay['bySource'][number];

/** One source: its tokens and cost, then each model it used when it used several. */
const SourceRow = ({ source }: { readonly source: CumulativeSource }) => {
  const [onlyModel] = source.models.length === 1 ? source.models : [];
  return (
    <li className="flex flex-col gap-px" data-testid={`context-usage-source-${source.kind}`}>
      <span className="text-muted-foreground flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">
          {SOURCE_LABELS[source.kind]}
          {onlyModel ? (
            <span className="text-muted-foreground">
              {' '}
              · {resolveModelLabel(onlyModel.provider, onlyModel.model)}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 gap-3 tabular-nums">
          <span className="text-muted-foreground">
            {formatCompact(source.inputTokens)} in · {formatCompact(source.outputTokens)} out
          </span>
          <span className="text-foreground w-14 text-right">
            {subtotalCostLabel(source.costUsd)}
          </span>
        </span>
      </span>
      {source.models.length > 1 && (
        <ul className="border-border/60 ml-1 flex flex-col gap-px border-l pl-2">
          {source.models.map((model) => (
            <li
              className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]"
              data-testid="context-usage-source-model"
              key={`${model.provider}::${model.model}`}
            >
              <span className="min-w-0 truncate" title={`${model.provider}::${model.model}`}>
                {resolveModelLabel(model.provider, model.model)}
              </span>
              <span className="flex shrink-0 gap-3 tabular-nums">
                <span>
                  {formatCompact(model.inputTokens)} in · {formatCompact(model.outputTokens)} out
                </span>
                <span className="w-14 text-right">{subtotalCostLabel(model.costUsd)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/**
 * Thread-total header (BST-953): the overall picture — what it cost, the in/out
 * split, the cache classes and what caching saved, then each source and model
 * with its own cost. The live in-flight run's step usage is added on top of the
 * durable figure and visibly marked, never silently blended into a "final"
 * number.
 */
export const CumulativeUsageSection = ({
  cumulativeUsage,
  liveRunUsage,
  label = 'Thread total',
}: CumulativeUsageSectionProps) => {
  const liveTokens = liveRunUsage ? liveRunUsage.inputTokens + liveRunUsage.outputTokens : 0;
  const totalTokens = cumulativeUsage.totalTokens + liveTokens;
  const inputTokens = cumulativeUsage.inputTokens + (liveRunUsage?.inputTokens ?? 0);
  const outputTokens = cumulativeUsage.outputTokens + (liveRunUsage?.outputTokens ?? 0);
  const hasCacheTraffic = cumulativeUsage.cacheReadTokens + cumulativeUsage.cacheCreationTokens > 0;
  const cachedShare =
    cumulativeUsage.inputTokens > 0
      ? Math.round((cumulativeUsage.cacheReadTokens / cumulativeUsage.inputTokens) * 100)
      : 0;
  const { bySource } = cumulativeUsage;
  const showSources = bySource.length > 1 || (bySource[0]?.models.length ?? 0) > 1;

  return (
    <div className="flex flex-col gap-1" data-testid="context-usage-thread-total">
      <p className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="font-medium" data-testid="context-usage-thread-total-tokens">
          {label} · {formatTokenCount(totalTokens)}
          {liveTokens > 0 ? ' (live)' : ''}
        </span>
        <span className="text-sm font-semibold" data-testid="context-usage-cost">
          {/* The durable cost excludes the in-flight live tokens above — say so
              rather than pairing a current total with a lagging price. */}
          {liveTokens > 0
            ? `${costLabel(cumulativeUsage.cost)} (excl. live)`
            : costLabel(cumulativeUsage.cost)}
        </span>
      </p>
      <p
        className="text-muted-foreground text-[11px] tabular-nums"
        data-testid="context-usage-thread-total-split"
      >
        {formatCompact(inputTokens)} in · {formatCompact(outputTokens)} out
        {cumulativeUsage.cost.available &&
        cumulativeUsage.cost.provenance === 'captured-usage-estimate'
          ? ' · list-price estimate'
          : ''}
      </p>
      {hasCacheTraffic && (
        <p
          className="bg-muted/60 text-muted-foreground rounded-md px-2 py-1 text-[11px] tabular-nums"
          data-testid="context-usage-cache-line"
        >
          Cache: {formatCompact(cumulativeUsage.cacheReadTokens)} read ({cachedShare}% of input) ·{' '}
          {formatCompact(cumulativeUsage.cacheCreationTokens)} written
          {cumulativeUsage.cacheSavings ? (
            <span className="text-foreground font-medium">
              {' '}
              · saved ~{formatUsdCost(cumulativeUsage.cacheSavings.usdAmount)}
            </span>
          ) : null}
        </p>
      )}
      {showSources && (
        <ul
          className="mt-0.5 flex flex-col gap-1 text-[11px]"
          data-testid="context-usage-by-source"
        >
          {bySource.map((source) => (
            <SourceRow key={source.kind} source={source} />
          ))}
        </ul>
      )}
    </div>
  );
};

CumulativeUsageSection.displayName = 'CumulativeUsageSection';

/** Actionable copy per awaiting-observer reason — a pause must say why. */
function awaitingObserverNote(reason: OmAwaitingObserverReason): string {
  switch (reason) {
    case 'model-not-eligible':
      return 'Observations on (Auto) — no recommended observer model is enabled in your model catalog; enable one (e.g. Gemini 2.5 Flash) or pick an observer in Assistant Memory settings';
    case 'no-chat-provider':
      return 'Observations on (Auto) — needs a chat provider with a saved key';
    case 'no-backend':
      return 'Observations on (Auto) — the assistant isn’t connected';
    case 'keys-unknown':
      return 'Observations on (Auto) — waiting for provider credentials to load';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Short note + testid for the non-`stats` OM states (honest, never a 0). Returns
 * null for `loading` so the OM line stays quiet during the initial fetch / a
 * thread switch instead of flashing the empty state.
 */
function omNote(state: OmMeterState): { text: string; tone: 'muted' | 'error' } | null {
  switch (state.kind) {
    case 'chat-only':
      return { text: 'Observations aren’t available here', tone: 'muted' };
    case 'inactive':
      return { text: 'Observations off', tone: 'muted' };
    case 'awaiting-observer':
      return { text: awaitingObserverNote(state.reason), tone: 'muted' };
    case 'empty':
      return { text: 'No observations yet', tone: 'muted' };
    case 'error':
      return { text: `Observations unavailable: ${state.reason}`, tone: 'error' };
    case 'withheld':
      return {
        text: 'Observations paused — this thread has branches, and its observations would mix them',
        tone: 'muted',
      };
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
        className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]"
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
        note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
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
  toolCalls: 'bg-lime-500/80',
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
 * The server-measured tool calls and results, shown as their own category only
 * beside the server-measured conversation (text only). The client walk already
 * counts tool activity inside its conversation estimate, so pairing it with
 * this figure would count tools twice.
 */
function toolCallsCategoryTokens(breakdown: AssistantContextBreakdown): number | undefined {
  return breakdown.historyMessagesTokens === undefined ? undefined : breakdown.toolCallsTokens;
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
    (toolCallsCategoryTokens(breakdown) ?? 0) +
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

/** Every named entry as a sub-row, biggest first as the breakdown lists them. */
function toEntrySubRows(
  entries: readonly { readonly name: string; readonly tokens: number }[],
  options: { labelPrefix: string; testIdPrefix: string }
): BreakdownRow[] {
  return entries.map((entry, index) => ({
    label: `${options.labelPrefix}${entry.name}`,
    testId: `${options.testIdPrefix}${index}`,
    value: `~${formatCompact(entry.tokens)}`,
  }));
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
      composer.subRowsByTestId['context-usage-breakdown-tool-definitions'] = toEntrySubRows(
        breakdown.toolDefinitionsByTool,
        {
          labelPrefix: '',
          testIdPrefix: 'context-usage-tooldef-',
        }
      );
    }
  }
  const toolCallsTokens = toolCallsCategoryTokens(breakdown);
  if (toolCallsTokens !== undefined) {
    pushCategory(
      composer,
      'toolCalls',
      {
        label: 'Tool calls and results',
        testId: 'context-usage-breakdown-tool-calls',
        value: `~${formatCompact(toolCallsTokens)}`,
      },
      toolCallsTokens
    );
    if (breakdown.toolCallsByTool && breakdown.toolCallsByTool.length > 0) {
      composer.subRowsByTestId['context-usage-breakdown-tool-calls'] = toEntrySubRows(
        breakdown.toolCallsByTool.map(({ tokens, toolName }) => ({ name: toolName, tokens })),
        {
          labelPrefix: '',
          testIdPrefix: 'context-usage-toolcall-',
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

/**
 * Conversation split sub-rows (you/assistant/reasoning/tools + per-tool). Tool
 * rows are left out when tool calls have their own category.
 */
function toConversationSubRows(
  conversationEstimate: ConversationTokenEstimate,
  toolsHaveOwnCategory: boolean
): BreakdownRow[] {
  const splitRows: BreakdownRow[] = [];
  const split: [string, string, number][] = [
    ['You', 'context-usage-conv-user', conversationEstimate.userTextTokens],
    ['Assistant', 'context-usage-conv-assistant', conversationEstimate.assistantTextTokens],
    ['Reasoning', 'context-usage-conv-reasoning', conversationEstimate.reasoningTokens],
  ];
  if (!toolsHaveOwnCategory) {
    split.push(['Tool activity', 'context-usage-conv-tools', conversationEstimate.toolTokens]);
  }
  for (const [label, testId, tokens] of split) {
    if (tokens > 0) {
      splitRows.push({ label, testId, value: `~${formatCompact(tokens)}` });
    }
  }
  if (!toolsHaveOwnCategory) {
    splitRows.push(
      ...toEntrySubRows(conversationEstimate.byTool, {
        labelPrefix: '· ',
        testIdPrefix: 'context-usage-conv-tool-',
      })
    );
  }
  return splitRows;
}

function composeConversationCategory(
  composer: BreakdownComposer,
  conversation: { estimated: boolean; tokens: number },
  conversationEstimate: ConversationTokenEstimate | undefined,
  toolsHaveOwnCategory: boolean
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
    const splitRows = toConversationSubRows(conversationEstimate, toolsHaveOwnCategory);
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
    composeConversationCategory(
      composer,
      conversation,
      conversationEstimate,
      breakdown !== undefined && toolCallsCategoryTokens(breakdown) !== undefined
    );
  }

  // Same authority split as the Conversation row: when the wire IS the
  // conversation (historyMessagesTokens present), the server count is the
  // measurement — including an honest 0 that must not be overridden by stale
  // UI history. Memory-backed runs measure only the current turn on the wire,
  // so the client walk (whole thread) speaks for the conversation instead.
  const attachmentsCount =
    breakdown?.historyMessagesTokens === undefined
      ? (conversationEstimate?.attachmentsCount ?? breakdown?.attachmentsCount ?? 0)
      : breakdown.attachmentsCount;
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
 * Pure width math for the capacity bar: proportional widths clamped so an
 * over-budget estimate can never overflow 100%. Kept OUTSIDE the component —
 * the running `remaining` accumulator must not be a render-scope reassignment
 * (React Compiler immutability).
 */
function computeSegmentWidths(
  segments: readonly CategorySegment[],
  effectiveInputBudget: number
): (CategorySegment & { width: number })[] {
  const widths: (CategorySegment & { width: number })[] = [];
  let remaining = 100;
  for (const segment of segments) {
    const raw = (segment.tokens / effectiveInputBudget) * 100;
    // Floor tiny segments to a visible sliver, but the remaining-budget clamp
    // wins LAST so the widths can never sum past 100 (an over-budget thread is
    // the inline critical notice's job, not the bar's).
    const width = Math.min(Math.max(raw, 0.75), remaining);
    remaining = Math.max(0, remaining - width);
    widths.push({ ...segment, width });
  }
  return widths;
}

/**
 * Segmented capacity bar over the effective input budget. Segments render in
 * legend order; the unfilled remainder is the muted track (free space).
 */
const CapacityBar = ({ effectiveInputBudget, segments }: CapacityBarProps) => {
  if (segments.length === 0) {
    return null;
  }
  const widths = computeSegmentWidths(segments, effectiveInputBudget);
  return (
    <div
      aria-hidden="true"
      className="bg-muted mt-1 flex h-1.5 w-full overflow-hidden rounded-full"
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
  /** In-flight run's billed step usage (BST-953 live tick). */
  liveRunUsage?: ThreadTokenUsage | undefined;
  omSegment?: OmMeterState | undefined;
  /** Opens the Context tab; present only where that tab exists. */
  onOpenContextMap?: (() => void) | undefined;
  percentage: number;
  usage?: ThreadTokenUsage | undefined;
  usedTokens: number;
  /**
   * Tokens the latest window holds for tool calls that delivered file lines,
   * from the thread context fold (null: the window was not recorded). Absent
   * where no fold exists (web, before the first committed run).
   */
  workspaceFileTokens?: number | null | undefined;
}

/** The same figure the Context tab's header shows, with the way there. */
const WorkspaceFilesRow = ({
  onOpenContextMap,
  tokens,
}: {
  readonly onOpenContextMap?: (() => void) | undefined;
  readonly tokens: number | null;
}) => (
  <p
    className="text-muted-foreground mt-1 flex items-center justify-between gap-2"
    data-testid="context-usage-workspace-files"
  >
    <span className="flex items-center gap-1.5">
      Workspace files in the window
      {onOpenContextMap && (
        <button
          className="text-foreground focus-visible:ring-ring text-[11px] underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:outline-hidden"
          data-testid="context-usage-open-context-map"
          onClick={onOpenContextMap}
          type="button"
        >
          Open context map
        </button>
      )}
    </span>
    <span className="tabular-nums">
      {tokens === null ? 'not recorded' : `~${formatCompact(tokens)}`}
    </span>
  </p>
);

export const ContextUsagePopoverContent = ({
  breakdownState,
  contextWindow,
  conversationEstimate,
  cumulativeUsage,
  effectiveInputBudget,
  estimatedTokens,
  isEstimated,
  liveRunUsage,
  omSegment,
  onOpenContextMap,
  percentage,
  usage,
  usedTokens,
  workspaceFileTokens,
}: ContextUsagePopoverContentProps) => {
  const { detailLevel } = useAssistantDetailLevel();
  const breakdownInvalid = breakdownState?.invalid === true;
  const { rows, segments, subRowsByTestId } = composeBreakdown({
    breakdown: breakdownState && !breakdownState.invalid ? breakdownState.breakdown : undefined,
    conversationEstimate,
    estimatedTokens,
    usage,
  });

  return (
    <div className="flex flex-col gap-1 text-xs">
      {/* Thread total FIRST (BST-953): the overall billed picture is the
          headline; context-window occupancy is a supporting section below.
          Only shown when hydrated from the DB (desktop). */}
      {cumulativeUsage && (
        <>
          <CumulativeUsageSection cumulativeUsage={cumulativeUsage} liveRunUsage={liveRunUsage} />
          <div aria-hidden="true" className="border-border/60 my-1 border-t" />
        </>
      )}

      {/* Context section: percent-full + used/budget fraction. The denominator
          is the effective input budget (contextWindow − output reservation);
          the full model window is on the line below so neither number is lost. */}
      <p
        className={cn('tabular-nums', cumulativeUsage ? undefined : 'font-medium')}
        data-testid="context-usage-popover-header"
      >
        Context {Math.round(percentage)}% full · {formatCompact(usedTokens)}
        {isEstimated ? ' (estimated)' : ''} / {formatTokenCount(effectiveInputBudget)}
      </p>
      <p className="text-muted-foreground text-[11px]" data-testid="context-usage-popover-window">
        model window {formatTokenCount(contextWindow)}
      </p>

      {/* Segmented capacity bar — same figures as the legend rows below. */}
      <CapacityBar effectiveInputBudget={effectiveInputBudget} segments={segments} />

      {/* Malformed wire part → surfaced honestly, never coerced into rows. */}
      {breakdownInvalid && (
        <p
          className="text-destructive/80 mt-1 text-[11px]"
          data-testid="context-usage-breakdown-invalid"
        >
          Prompt breakdown unavailable (malformed data from the last run).
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5" data-testid="context-usage-breakdown">
          {rows.map((row) => (
            <li className="flex flex-col gap-0.5" data-testid={row.testId} key={row.testId}>
              <span className="text-muted-foreground flex items-center justify-between gap-2">
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
                <ul className="border-border/60 ml-3.5 flex max-h-48 flex-col gap-px overflow-y-auto border-l pl-2">
                  {subRowsByTestId[row.testId]?.map((subRow) => (
                    <li
                      className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]"
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

      {workspaceFileTokens !== undefined && (
        <WorkspaceFilesRow onOpenContextMap={onOpenContextMap} tokens={workspaceFileTokens} />
      )}

      {/* OM informational stats (observed tokens + compaction saved), or an
          honest note for the other states. NOT a budget segment — the
          observation does not consume this turn's input budget. A host
          without memory supplies { kind: 'chat-only' } so the stats are
          hidden, never zeros. */}
      {omSegment && <OmMeterSection state={omSegment} />}
      {omSegment && detailLevel === 'developer' && <MemoryDeveloperPanel state={omSegment} />}
    </div>
  );
};

ContextUsagePopoverContent.displayName = 'ContextUsagePopoverContent';
