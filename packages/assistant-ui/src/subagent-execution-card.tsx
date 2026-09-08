import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { SUBAGENT_NO_ANSWER_OUTCOME } from '@brainstrike/assistant-contract/personas';
import { AlertCircle, CheckCircle, CircleDashed, CircleSlash } from 'lucide-react';
import { type ComponentProps, type ReactElement, useId, useMemo, useState } from 'react';
import type { StepGlyphState } from './activity-step-icons';
import { StepRowHeader } from './activity-step-row';
import { toolStepStateFor } from './activity-trace-model';
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
  'toolName' | 'toolCallId' | 'result' | 'status'
> & {
  /** In-flight child rows from live `subagent.tool.*` events (see SUBAGENTS). */
  liveRows?: readonly SubAgentToolRow[];
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
 * to Explorer" while the child runs (and while the call waits at an approval
 * gate: it has not started either way), then "Explorer finished" / "Explorer
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
  running: (label) => `Delegating to ${label}`,
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
  success: (
    <CheckCircle
      aria-hidden="true"
      className="size-3.5 shrink-0 text-green-600 dark:text-green-500"
    />
  ),
};

/**
 * The delegation's step state: THE shared tool-step machine
 * (`toolStepStateFor` — the same derivation the trace headline, the run-event
 * surface and `ToolFallback` read) plus the one refinement only this card can
 * make. `no-answer` is a reading of the delegation's OWN result shape
 * (BST-1410: the child ran, made tool calls, and never wrote its summary), so
 * it is applied strictly on TOP of a generic `done` — running, waiting,
 * cancelled and failed keep winning, or a delegation the user stopped would
 * read as an outcome it never reached (and, before this, as `failed`).
 *
 * `isError` is deliberately absent from the input: the presentational card is
 * not handed the part's flag (see `SubagentCardProps`), and a delegation
 * result that states its own error is already read by the shared machine.
 */
function resolveDelegationState(
  status: ToolStatus,
  result: ToolResult,
  outcome: SubagentDelegationOutcome | undefined
): StepGlyphState {
  const generic = toolStepStateFor({ result, status });
  if (generic !== 'done') {
    return generic;
  }
  return outcome === SUBAGENT_NO_ANSWER_OUTCOME ? 'no-answer' : 'done';
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
  toolName,
  toolCallId,
  result,
  status,
  liveRows = EMPTY_LIVE_ROWS,
  outcome,
}: SubagentCardProps) => {
  const [expanded, setExpanded] = useState(false);
  const rowsId = useId();
  const stepState = resolveDelegationState(status, result, outcome);
  const label = personaLabelForToolName(toolName);
  const rows = useMemo(
    () => mergeSubagentToolRows(readSubAgentToolRows(result), liveRows),
    [result, liveRows]
  );
  const durationMs = useToolDurationMs(toolCallId);
  const elapsed = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const hasRows = rows.length > 0;

  return (
    <div className="my-1 rounded-md border border-border bg-muted/30 text-sm">
      <StepRowHeader
        family="delegate"
        label={expanded ? 'Collapse details' : 'Expand details'}
        state={stepState}
        stepId={toolCallId}
        target={null}
        timing={elapsed}
        toolName={toolName}
        trailing={
          <span className="bs-step-row-meta">
            · {rows.length} tool {rows.length === 1 ? 'call' : 'calls'}
          </span>
        }
        verb={STEP_VERB[stepState](label)}
        // Conditional spread, not `prop={x ?? undefined}`: under
        // `exactOptionalPropertyTypes` an optional prop may be absent but
        // never explicitly `undefined`. With no child rows there is nothing to
        // expand, so the row renders as its non-interactive form instead of a
        // disabled button.
        {...(hasRows
          ? { bodyId: rowsId, expanded, onToggle: () => setExpanded((value) => !value) }
          : {})}
      />
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
