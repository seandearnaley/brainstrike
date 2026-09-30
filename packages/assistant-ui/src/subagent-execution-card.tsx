import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  SUBAGENT_NO_ANSWER_OUTCOME,
  SUBAGENT_REJECTED_OUTCOME,
  SUBAGENT_TRUNCATED_OUTCOME,
} from '@brainstrike/assistant-contract/personas';
import { Button } from '@brainstrike/ui';
import { AlertCircle, ArrowUpRight, CheckCircle, CircleDashed, CircleSlash } from 'lucide-react';
import {
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  useId,
  useMemo,
  useState,
} from 'react';
import type { StepGlyphState } from './activity-step-icons';
import { StepRowHeader } from './activity-step-row';
import { toolStepStateFor } from './activity-trace-model';
import { agentColorStyle } from './agent-color-style';
import { resolveToolDisplayPolicy } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import type { SubagentConversationPresentation } from './subagent-conversation-navigation';
import { personaLabelForToolName } from './subagent-persona-label';
import {
  mergeSubagentToolRows,
  readSubAgentToolRows,
  type SubAgentToolRow,
  type SubAgentToolRowStatus,
  type SubagentDelegationOutcome,
} from './subagent-tool-rows';
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';

/** Presentational-card props: the tool-part fields plus optional live rows. */
export type SubagentCardProps = Pick<
  ComponentProps<ToolCallMessagePartComponent>,
  'isError' | 'result' | 'status' | 'toolCallId' | 'toolName'
> & {
  /** In-flight child rows from live `subagent.tool.*` events (see SUBAGENTS). */
  liveRows?: readonly SubAgentToolRow[];
  presentation?: SubagentConversationPresentation;
  task?: string;
  onOpenConversation?: (event: MouseEvent<HTMLButtonElement>) => void;
  navigationError?: string;
  presentationError?: string;
  onReloadPresentation?: () => void;
  /**
   * Terminal outcome the tool-call status cannot express (BST-1410) — today
   * only `'no-answer'`: the child ran, made tool calls, and never wrote its
   * summary. The delegation tool call itself SUCCEEDED, so without this the
   * card reports that as Completed.
   */
  outcome?: SubagentDelegationOutcome | undefined;
};
type ToolStatus = SubagentCardProps['status'];
type ToolResult = SubagentCardProps['result'];

/**
 * The row verb per step state (BST-1681). The card draws no status icon or
 * `· Failed` label of its own: the row's glyph names the state (`role="img"`)
 * and the verb says what happened. A delegation is the one step whose subject
 * is a persona rather than the assistant, so the verb names it — "Delegating
 * to Explorer" while the call waits at an approval gate, then "Explorer is
 * working" once the child runs, and "Explorer finished" / "Explorer
 * gave no answer" / "Explorer stopped" / "Explorer failed" once it settles.
 *
 * Keyed by `StepGlyphState`, not by a private display union, so the type
 * proves the table is TOTAL over what the shared state machine can hand it: a
 * state added there and forgotten here is a compile error rather than a blank
 * verb.
 */
const STEP_VERB: Record<StepGlyphState, (label: string) => string> = {
  cancelled: (label) => `${label} stopped`,
  done: (label) => `${label} finished`,
  failed: (label) => `${label} failed`,
  'no-answer': (label) => `${label} gave no answer`,
  rejected: (label) => `${label} delegation rejected`,
  running: (label) => `${label} is working`,
  truncated: (label) => `${label} finished with a truncated summary`,
  waiting: (label) => `Delegating to ${label}`,
};

const ROW_ICONS: Record<SubAgentToolRowStatus, ReactElement> = {
  error: <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />,
  interrupted: (
    <CircleSlash aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
  ),
  running: (
    <CircleDashed
      aria-hidden="true"
      className="size-3.5 shrink-0 animate-pulse text-muted-foreground motion-reduce:animate-none"
      data-live="true"
    />
  ),
  success: <CheckCircle aria-hidden="true" className="size-3.5 shrink-0 text-success" />,
};

/**
 * The delegation's step state: THE shared tool-step machine
 * (`toolStepStateFor` — the same derivation its four consumers read:
 * `deriveActivitySteps` for the trace headline and step rows, `ToolFallback`,
 * `TaskListToolCard`, and this card) plus the one refinement only this card
 * can make. `no-answer` is a reading of the delegation's OWN result shape
 * (BST-1410: the child ran, made tool calls, and never wrote its summary), so
 * it is applied strictly on TOP of a generic `done` — running, waiting,
 * cancelled and failed keep winning, or a delegation the user stopped would
 * read as an outcome it never reached (and, before this, as `failed`).
 *
 * `isError` is the part-level flag, threaded through `SubagentCardProps` from
 * the connected wrapper (Task 5 fix-wave gap): the card used not to be handed
 * it, so a delegation the runtime marked as errored — without the result
 * saying so itself — read `Explorer finished` here while the group summary,
 * which sees the flag, counted the same step as failed.
 *
 * No `toolName` is passed: the tool-specific settled readings in the shared
 * machine belong to `run_python`, and a delegation is not it. The declined
 * envelope is tool-agnostic and applies here as it does everywhere.
 */
function resolveDelegationState(
  status: ToolStatus,
  result: ToolResult,
  outcome: SubagentDelegationOutcome | undefined,
  isError: boolean
): StepGlyphState {
  const generic = toolStepStateFor({ isError, result, status });
  if (generic !== 'done') {
    return generic;
  }
  if (outcome === SUBAGENT_REJECTED_OUTCOME) {
    // BST-1751: refused before the child ran; the tool call itself succeeded.
    return 'rejected';
  }
  if (outcome === SUBAGENT_TRUNCATED_OUTCOME) {
    // The child's reserved summary was cut at its synthesis budget: a
    // completion with partial findings, named as such.
    return 'truncated';
  }
  return outcome === SUBAGENT_NO_ANSWER_OUTCOME ? 'no-answer' : 'done';
}

function SubagentTaskSummary({
  label,
  presentation,
  task,
}: {
  readonly label: string;
  readonly presentation: SubagentConversationPresentation | undefined;
  readonly task: string | undefined;
}) {
  if (!(presentation || task)) {
    return null;
  }
  return (
    <div className="flex min-w-0 items-start gap-2 px-3 pb-2">
      {presentation ? (
        <span
          aria-hidden="true"
          className={`mt-0.5 size-3 shrink-0 rounded-full border-2 ${presentation.markClassName}`}
        />
      ) : null}
      <div className="min-w-0 text-xs">
        <span className="font-medium text-muted-foreground">{label}</span>
        {task ? <p className="line-clamp-2 whitespace-pre-wrap break-words">{task}</p> : null}
      </div>
    </div>
  );
}

function SubagentPresentationError({
  error,
  onReload,
}: {
  readonly error: string | undefined;
  readonly onReload: (() => void) | undefined;
}) {
  if (!error) {
    return null;
  }
  return (
    <div className="border-border border-t px-3 py-2 text-xs">
      <p className="text-destructive" role="alert">
        {error}
      </p>
      {onReload ? (
        <Button onClick={onReload} size="sm" variant="ghost">
          Reload child details
        </Button>
      ) : null}
    </div>
  );
}

const EMPTY_LIVE_ROWS: readonly SubAgentToolRow[] = [];

/**
 * Collapsed card for a subagent delegation (`agent-<key>`) tool part. Status
 * comes from `status.type`; per-child rows merge the persisted result's
 * `subAgentToolResults` (authoritative at completion + on reload) with LIVE
 * in-flight `subagent.tool.*` rows (`liveRows`, threaded by the connected
 * wrapper). Nested `subagent.*` run events are filtered out of the main timeline
 * (they belong to this card).
 */
export const SubagentExecutionCard = ({
  isError = false,
  toolName,
  toolCallId,
  result,
  status,
  liveRows = EMPTY_LIVE_ROWS,
  onOpenConversation,
  navigationError,
  presentationError,
  onReloadPresentation,
  presentation,
  task,
  outcome,
}: SubagentCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  const { detailLevel } = useAssistantDetailLevel();
  const policy = resolveToolDisplayPolicy(detailLevel);
  const stepState = resolveDelegationState(status, result, outcome, isError);
  const label = personaLabelForToolName(toolName);
  const rows = useMemo(
    () => mergeSubagentToolRows(readSubAgentToolRows(result), liveRows),
    [result, liveRows]
  );
  const durationMs = useToolDurationMs(toolCallId);
  const elapsed = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const hasRows = rows.length > 0;

  return (
    <div
      className="bs-subagent-card my-1 rounded-md border border-border bg-muted/30 text-sm"
      data-agent-color={presentation?.colorId}
      style={agentColorStyle(presentation?.colorId)}
    >
      <StepRowHeader
        family="delegate"
        label={expanded ? 'Collapse details' : 'Expand details'}
        state={stepState}
        stepId={toolCallId}
        target={null}
        timing={elapsed}
        toolName={toolName}
        // Gated on the same Detail-level policy `ToolFallback`'s own
        // result-summary chip reads (BST-1686): compact hides EVERY trailing
        // result chip in the trace, and this card's tool-call count is one —
        // it just used to be the one chip the Detail control never touched.
        trailing={
          policy.showResultSummary ? (
            <span className="bs-step-row-meta">
              · {rows.length} tool {rows.length === 1 ? 'call' : 'calls'}
            </span>
          ) : null
        }
        verb={STEP_VERB[stepState](presentation?.displayName ?? label)}
        // Conditional spread, not `prop={x ?? undefined}`: under
        // `exactOptionalPropertyTypes` an optional prop may be absent but
        // never explicitly `undefined`. With no child rows there is nothing to
        // expand, so the row renders as its non-interactive form instead of a
        // disabled button.
        {...(hasRows
          ? { bodyId: rowsId, expanded, onToggle: () => setExpanded((value) => !value) }
          : {})}
      />
      <SubagentTaskSummary label={label} presentation={presentation} task={task} />
      {navigationError ? (
        <p className="border-border border-t px-3 py-2 text-destructive text-xs" role="alert">
          {navigationError}
        </p>
      ) : null}
      <SubagentPresentationError error={presentationError} onReload={onReloadPresentation} />
      {onOpenConversation ? (
        <div className="flex justify-end border-border border-t px-2 py-1">
          <Button
            aria-label={`Open ${presentation?.displayName ?? label} conversation`}
            className="h-7 gap-1.5 text-xs"
            onClick={onOpenConversation}
            size="sm"
            variant="ghost"
          >
            Open conversation <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {expanded && hasRows ? (
        <ul className="border-border border-t px-3 py-2" id={rowsId}>
          {rows.map((row) => (
            <li className="flex items-center gap-2 py-1" key={row.key}>
              {ROW_ICONS[row.status]}
              <span className="font-mono text-xs">{row.toolName}</span>
              {row.argSummary ? (
                <span className="truncate text-muted-foreground text-xs">{row.argSummary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
