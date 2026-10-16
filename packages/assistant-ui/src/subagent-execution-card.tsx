import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { Button } from '@brainstrike/ui';
import { ArrowUpRight } from 'lucide-react';
import type { ComponentProps, MouseEvent } from 'react';
import type { StepGlyphState } from './activity-step-icons';
import { StepRowHeader } from './activity-step-row';
import { toolStepStateFor } from './activity-trace-model';
import { agentColorStyle } from './agent-color-style';
import { resolveToolDisplayPolicy } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { SubagentApprovalHistory } from './subagent-approval-history';
import type {
  SubagentAnsweredApproval,
  SubagentChildRun,
  SubagentConversationPresentation,
} from './subagent-conversation-navigation';
import { personaLabelForToolName } from './subagent-persona-label';
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';

/** Presentational-card props: the tool-part fields plus the child's committed run. */
export type SubagentCardProps = Pick<
  ComponentProps<ToolCallMessagePartComponent>,
  'isError' | 'result' | 'status' | 'toolCallId' | 'toolName'
> & {
  /**
   * The delegated child's run state, folded from its own committed log by the
   * conversation's owner; absent until that log is read, or when no child ran.
   */
  childRun?: SubagentChildRun | undefined;
  presentation?: SubagentConversationPresentation;
  /** BST-1932 (AT-07): the child's answered approvals, shown as its history. */
  approvalHistory?: readonly SubagentAnsweredApproval[];
  task?: string;
  onOpenConversation?: (event: MouseEvent<HTMLButtonElement>) => void;
  navigationError?: string;
  presentationError?: string;
  onReloadPresentation?: () => void;
};
type ToolStatus = SubagentCardProps['status'];
type ToolResult = SubagentCardProps['result'];

/**
 * The row verb per step state (BST-1681). The card draws no status icon or
 * `· Failed` label of its own: the row's glyph names the state (`role="img"`)
 * and the verb says what happened. A delegation is the one step whose subject
 * is a persona rather than the assistant, so the verb names it — "Delegating
 * to Explorer" while the call waits at an approval gate, then "Explorer is
 * working" while the child runs, and "Explorer finished" / "Explorer gave no
 * answer" / "Explorer stopped" / "Explorer failed" once it settles.
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

/**
 * A child's committed run status as a step state, read as the child's own
 * conversation reads it. An interrupted run (the host restarted under it) is
 * reported to the parent as failed (`settledState` in the host's child
 * manager), so it reads failed here too.
 */
const CHILD_STEP_STATE: Record<SubagentChildRun['status'], StepGlyphState> = {
  completed: 'done',
  failed: 'failed',
  interrupted: 'failed',
  'needs-input': 'waiting',
  'no-answer': 'no-answer',
  running: 'running',
  stopped: 'cancelled',
  unavailable: 'failed',
};

/**
 * The host's committed delegation result statuses (agent-host
 * `HostChildResultSchema`) as step states. `started` is a background child's
 * acknowledgement: it proves the child started, never that it finished
 * ("Starting work never proves completion", docs/agents/assistant-subagents.md).
 */
const RESULT_STEP_STATE: Readonly<Record<string, StepGlyphState>> = {
  completed: 'done',
  failed: 'failed',
  interrupted: 'failed',
  'no-answer': 'no-answer',
  rejected: 'rejected',
  started: 'running',
  stopped: 'cancelled',
};

function resultStepState(result: ToolResult): StepGlyphState | undefined {
  if (typeof result !== 'object' || result === null || !('status' in result)) {
    return;
  }
  const status = result.status;
  return typeof status === 'string' ? RESULT_STEP_STATE[status] : undefined;
}

/**
 * The delegation's step state. Once the child's own committed run is read it
 * is the truth: a background delegation's call settles the moment its child
 * starts, so the call alone would say "finished" while the child works, and
 * stays the `started` acknowledgement after the child ends. The child's run
 * reads `no-answer` by the host's own rule (BST-1410: the child ran and wrote
 * no summary), so a foreground and a background delegation read alike.
 *
 * Before then, THE shared tool-step machine (`toolStepStateFor`, which the
 * trace headline, `ToolFallback` and `TaskListToolCard` also read) decides,
 * refined by the host's committed result: a refused delegation, a no-answer,
 * or a background start, which reads as working until the child's log says
 * otherwise. Running, waiting, cancelled and failed calls keep winning.
 *
 * No `toolName` is passed: the tool-specific settled readings in the shared
 * machine belong to `run_python`, and a delegation is not it.
 */
function resolveDelegationState(
  status: ToolStatus,
  result: ToolResult,
  isError: boolean,
  childRun: SubagentChildRun | undefined
): StepGlyphState {
  if (childRun) {
    return CHILD_STEP_STATE[childRun.status];
  }
  const generic = toolStepStateFor({ isError, result, status });
  return generic === 'done' ? (resultStepState(result) ?? 'done') : generic;
}

/** A child waiting on a person is not delegating: it asks for their input. */
function delegationVerb(
  state: StepGlyphState,
  childRun: SubagentChildRun | undefined,
  label: string
): string {
  if (childRun?.status === 'needs-input') {
    return `${label} needs your input`;
  }
  // Nothing is known of the child's run, only that its log cannot be read.
  return childRun?.status === 'unavailable'
    ? `${label}’s progress is unavailable`
    : STEP_VERB[state](label);
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

const EMPTY_APPROVAL_HISTORY: readonly SubagentAnsweredApproval[] = [];

/**
 * Collapsed card for a subagent delegation (`agent-<key>`) tool part. Its
 * state and tool-call count are the delegated child's committed run
 * (`childRun`, threaded by the connected wrapper from the conversation's
 * owner); the child's activity itself lives in its own conversation, which the
 * card opens.
 */
export const SubagentExecutionCard = ({
  approvalHistory = EMPTY_APPROVAL_HISTORY,
  childRun,
  isError = false,
  toolName,
  toolCallId,
  result,
  status,
  onOpenConversation,
  navigationError,
  presentationError,
  onReloadPresentation,
  presentation,
  task,
}: SubagentCardProps) => {
  const { detailLevel } = useAssistantDetailLevel();
  const policy = resolveToolDisplayPolicy(detailLevel);
  const stepState = resolveDelegationState(status, result, isError, childRun);
  const label = personaLabelForToolName(toolName);
  const durationMs = useToolDurationMs(toolCallId);
  const elapsed = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const toolCalls = childRun?.toolCalls;

  return (
    <div
      className="bs-subagent-card my-1 rounded-md border border-border bg-muted/30 text-sm"
      data-agent-color={presentation?.colorId}
      data-testid="subagent-execution-card"
      style={agentColorStyle(presentation?.colorId)}
    >
      <StepRowHeader
        family="delegate"
        label="Delegation details"
        state={stepState}
        stepId={toolCallId}
        target={null}
        timing={elapsed}
        toolName={toolName}
        // Gated on the same Detail-level policy `ToolFallback`'s own
        // result-summary chip reads (BST-1686). An unread count is unknown,
        // never zero, so it shows only once the child's log is read.
        trailing={
          policy.showResultSummary && toolCalls !== undefined ? (
            <span className="bs-step-row-meta">
              · {toolCalls} tool {toolCalls === 1 ? 'call' : 'calls'}
            </span>
          ) : null
        }
        verb={delegationVerb(stepState, childRun, presentation?.displayName ?? label)}
      />
      <SubagentTaskSummary label={label} presentation={presentation} task={task} />
      <SubagentApprovalHistory approvals={approvalHistory} colorId={presentation?.colorId} />
      {navigationError ? (
        <p className="border-border border-t px-3 py-2 text-destructive text-xs" role="alert">
          {navigationError}
        </p>
      ) : null}
      {childRun?.status === 'unavailable' ? (
        <p className="border-border border-t px-3 py-2 text-destructive text-xs" role="alert">
          {childRun.reason}
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
    </div>
  );
};
