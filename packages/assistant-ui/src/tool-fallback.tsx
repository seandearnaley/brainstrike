import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { isRevertibleCaptureStatus } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Undo2 } from 'lucide-react';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from 'react';
import { StepRowHeader } from './activity-step-row';
import {
  type ActivityStepState,
  runPythonStepState,
  toolStepStateFor,
} from './activity-trace-model';
import { verbForTool } from './activity-verbs';
import { resolveToolDisplayPolicy } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import {
  REVERTIBLE_MUTATION_TOOL_NAMES,
  useCheckpointForToolCall,
} from './edit-checkpoint-context';
import { LiveShellOutputPane } from './live-shell-output-pane';
import { RunPythonResultSurface } from './run-python-result';
import {
  narrowRunPythonDisplayResult,
  type RunPythonDisplayResult,
} from './run-python-result-model';
import { useShellOutput } from './shell-output-context';
import { useRememberedToolArguments } from './tool-argument-context';
import { shouldUseRememberedToolArguments, type ToolArguments } from './tool-arguments';
import { useToolDurationMs } from './tool-duration-context';
import { formatActivityDuration } from './tool-durations';
import { extractPrimaryArg, summarizeResult } from './tool-summaries';
import { categoryTintClasses, classifyToolName } from './tool-visual-classification';
import { useToolCallProgressLabel } from './use-tool-call-progress';

type ToolFallbackProps = ComponentProps<ToolCallMessagePartComponent>;
type ToolStatus = ToolFallbackProps['status'];
type ToolResult = ToolFallbackProps['result'];

/**
 * The card's state, and the structured `run_python` result it may render
 * beneath the row.
 *
 * The state is `toolStepStateFor` and nothing else — the SAME derivation the
 * trace headline, the step rows and the task-list/subagent cards read. The
 * two readings this card used to layer on top of it (the declined envelope,
 * and `run_python`'s own five-arm mapping) moved INTO that function in
 * BST-1681 phase 3: while they lived here a declined call read `Stopped` on
 * the card and `Completed` in the headline at the same time. There is no
 * card-only state left to resolve.
 *
 * The narrowing survives here for RENDERING only, gated by an IDENTITY check:
 * the structured surface renders exactly when this result is what PRODUCED
 * the card's state — i.e. `runPythonStepState` of it equals the state on
 * screen. That is not the same as "never under non-`done` chrome", and
 * deliberately so: a settled run whose own payload reads `unavailable` DOES
 * show its surface under failed chrome, and one reading `timed_out`/`killed`
 * under stopped chrome, because in each case that payload IS the reason for
 * the state and is the detail the user came for. What the check excludes is a
 * surface that would explain something else — a still-running
 * or approval-gated call shows none however complete its payload looks, and a
 * transport abort keeps its own error line instead of a stale success pane.
 */
function resolveCardStatus(
  toolName: string,
  status: ToolStatus,
  result: ToolResult,
  isErrorResult: boolean
): { glyphState: ActivityStepState; runPythonResult: RunPythonDisplayResult | null } {
  const glyphState = toolStepStateFor({ isError: isErrorResult, result, status, toolName });
  const narrowed =
    toolName === NATIVE_TOOL_ID.runPython ? narrowRunPythonDisplayResult(result) : null;
  return {
    glyphState,
    runPythonResult: narrowed && runPythonStepState(narrowed) === glyphState ? narrowed : null,
  };
}

const isIncompleteStatus = (
  status: ToolStatus
): status is ToolStatus & { type: 'incomplete'; error?: unknown; reason?: unknown } =>
  status.type === 'incomplete';

const readResultErrorMessage = (result: ToolResult, isErrorResult = false): string | undefined => {
  if (typeof result === 'string') {
    return;
  }
  if (!(result && typeof result === 'object')) {
    return;
  }

  const record = result as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (record['ok'] === false && error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  if (isErrorResult || record['isError'] === true) {
    return 'Tool execution failed.';
  }
  return;
};

const resolveErrorMessage = (
  status: ToolStatus,
  result: ToolResult,
  isErrorResult: boolean
): string | undefined => {
  if (!isIncompleteStatus(status)) {
    return readResultErrorMessage(result, isErrorResult);
  }

  if (typeof status.error === 'string') {
    return status.error;
  }

  if (status.error !== undefined) {
    try {
      return JSON.stringify(status.error);
    } catch {
      return String(status.error);
    }
  }

  if (typeof result === 'string') {
    return result;
  }

  if (status.reason !== undefined) {
    return `Tool incomplete: ${String(status.reason)}`;
  }

  return 'Tool incomplete: unknown';
};

const formatResult = (result: ToolResult): string => {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '';
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
};

function useDisplayToolArguments(
  toolCallId: string,
  args: unknown,
  argsText: string | undefined
): ToolArguments {
  const remembered = useRememberedToolArguments(toolCallId);
  if (!(remembered && shouldUseRememberedToolArguments(args))) {
    return { args, ...(argsText === undefined ? {} : { argsText }) };
  }
  return remembered;
}

function extractResolvedRootName(result: ToolResult): string | undefined {
  if (!(result && typeof result === 'object' && !Array.isArray(result))) {
    return;
  }
  const rootName = (result as Record<string, unknown>)['rootName'];
  return typeof rootName === 'string' && rootName.trim() ? rootName.trim() : undefined;
}

/**
 * ToolFallback renders a tool call as the most prominent element in the run:
 * a tinted card whose header IS the shared activity step row (BST-1681) —
 * family icon, verb in tense, target chip, timing, state glyph — over
 * collapsible Arguments/Result panes.
 *
 * Its state comes from `toolStepStateFor` and from nothing else — the SAME
 * derivation the trace headline and the group's step rows use, with no
 * card-only overrides left on top of it, so a step can never read one state
 * here and another there:
 * - `running`: live glyph + progress label; nothing to expand yet, so the row
 *   is not a button
 * - `waiting`: a LIVE pause — the part's status is `requires-action`, so the
 *   row reads "Waiting for approval"
 * - `done`: shows the result summary; the ROW is the expander for the details.
 *   A resultless call on a settled message lands here too: after a reload the
 *   thread carries no record that the pause was ever abandoned, and inventing
 *   one on the card would contradict the trace. Recording that outcome is
 *   persistence work (BST-1678), not something the card may guess at.
 * - `cancelled`: stopped without completing (an `incomplete`/cancelled status,
 *   a decline, a stopped run_python) — muted, never destructive chrome
 * - `failed`: shows the error message inline in red under the row
 */
export const ToolFallback: ToolCallMessagePartComponent = (props) => {
  const {
    toolCallId,
    toolName,
    args,
    argsText,
    result,
    isError: isErrorResult = false,
    status,
  } = props;
  const { detailLevel } = useAssistantDetailLevel();
  const policy = resolveToolDisplayPolicy(detailLevel);
  const durationMs = useToolDurationMs(toolCallId);
  const durationLabel = durationMs === undefined ? undefined : formatActivityDuration(durationMs);
  const { args: displayArgs, argsText: displayArgsText } = useDisplayToolArguments(
    toolCallId,
    args,
    argsText
  );

  // Follow the Detail level (policy.defaultExpanded) until the user explicitly
  // toggles this card — so switching to Developer auto-expands already-rendered
  // cards (and Compact re-collapses them), while an explicit toggle still wins.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const isCollapsed = userCollapsed ?? !policy.defaultExpanded;
  const detailsId = useId();

  const hasResult = result !== undefined;
  const { glyphState, runPythonResult } = resolveCardStatus(
    toolName,
    status,
    result,
    isErrorResult
  );
  const verb = verbForTool(toolName);
  // A waiting/cancelled/failed step reads the past tense with the glyph
  // carrying the state — consistent with the trace's resting summary, which
  // lists failed verbs in the done tense too.
  const verbLabel = glyphState === 'running' ? verb.active : verb.done;
  const isRunning = glyphState === 'running';
  const isError = glyphState === 'failed';
  // BST-849: while the model streams a large tool input the card must visibly
  // move — received bytes off the raw (live) `argsText`, elapsed off the part
  // timing — or a two-minute file write reads exactly like a hung run.
  const { argsStreaming, label: progressLabel } = useToolCallProgressLabel(props, isRunning);
  const errorMessage = resolveErrorMessage(status, result, isErrorResult);
  const showDetails =
    policy.showDetailsExpander && !isRunning && (Boolean(displayArgsText) || hasResult);

  const primaryArg = useMemo(
    () => extractPrimaryArg(displayArgs, displayArgsText),
    [displayArgs, displayArgsText]
  );
  const resultSummary = useMemo(
    () => (isError || !policy.showResultSummary ? undefined : summarizeResult(result)),
    [isError, policy.showResultSummary, result]
  );
  const resolvedRootName = useMemo(() => extractResolvedRootName(result), [result]);

  const category = classifyToolName(toolName);
  const tint = categoryTintClasses(category);

  return (
    <div
      className={`bs-tool-timeline my-1 rounded-lg border ${
        isError ? 'border-destructive/50 bg-destructive/5' : tint.card
      }`}
      data-testid="tool-fallback"
      data-tool-category={category}
    >
      <div className="bs-step-row-line px-1">
        <StepRowHeader
          family={verb.family}
          label={isCollapsed ? 'Expand details' : 'Collapse details'}
          state={glyphState}
          stepId={toolCallId}
          target={primaryArg?.display ?? null}
          timing={
            <ToolRunTiming
              argsStreaming={argsStreaming}
              durationLabel={durationLabel}
              isRunning={isRunning}
              progressLabel={progressLabel}
            />
          }
          toolName={toolName}
          trailing={
            <>
              {resultSummary ? <span className="bs-step-row-meta">{resultSummary}</span> : null}
              {resolvedRootName ? (
                <span
                  className="bs-step-row-meta"
                  title={`Resolved workspace root: ${resolvedRootName}`}
                >
                  in {resolvedRootName}
                </span>
              ) : null}
            </>
          }
          verb={verbLabel}
          // Conditional spreads, not `prop={x ?? undefined}`: under
          // `exactOptionalPropertyTypes` an optional prop may be absent but
          // never explicitly `undefined`. The toggle trio travels together —
          // a row with no details pane is not interactive at all.
          {...(showDetails
            ? {
                bodyId: detailsId,
                expanded: !isCollapsed,
                onToggle: () => setUserCollapsed(!isCollapsed),
              }
            : {})}
          {...(primaryArg?.full === undefined ? {} : { targetTitle: primaryArg.full })}
        />
        {isRunning || isError ? null : (
          <CheckpointRevertButton toolCallId={toolCallId} toolName={toolName} />
        )}
      </div>

      {isError && errorMessage ? (
        <p className="px-2 pb-1 text-destructive text-xs">{errorMessage}</p>
      ) : null}

      {/* Live incremental output while the command runs. Once it finishes, the
          captured output lives in the collapsible Result pane, so the live pane
          only shows during execution (transient — absent on a reloaded thread). */}
      <LiveShellOutputRegion isRunning={isRunning} toolCallId={toolCallId} />

      {/* Structured run_python result (BST-1070): state-honest header + output
          panes. The raw result object stays available in the details pane. */}
      <RunPythonResultRegion isRunning={isRunning} result={runPythonResult} />

      {showDetails && !isCollapsed ? (
        <ToolDetailsPane
          argsText={displayArgsText}
          detailsId={detailsId}
          hasResult={hasResult}
          isError={isError}
          result={result}
          showRawIo={policy.showRawIo}
          toolCallId={toolCallId}
          toolName={toolName}
        />
      ) : null}
    </div>
  );
};

ToolFallback.displayName = 'ToolFallback';

/**
 * The header's timing slot: the live progress label while the call runs
 * (BST-849), the measured execution time once it has finished.
 */
function ToolRunTiming({
  argsStreaming,
  durationLabel,
  isRunning,
  progressLabel,
}: {
  argsStreaming: boolean;
  durationLabel: string | undefined;
  isRunning: boolean;
  progressLabel: string;
}): ReactNode {
  if (isRunning) {
    return (
      <AssistantThinkingIndicator
        // Shrinkable, unlike the settled duration: a label such as
        // "Receiving input · 999.9 KB · 9m 59s" must truncate in a narrow
        // pane rather than squeeze the target chip out of its slot. That
        // geometry belongs to the SLOT, not to this indicator, and lives in
        // `.bs-step-row-timing` (overrides.css): the `max-w-[60%] shrink
        // min-w-0` this used to carry sat inside the slot, where the
        // percentage resolved against the slot's own width and `flex-shrink`
        // was inert (the slot is a block container, not a flex one).
        className="text-xs tabular-nums"
        data-args-streaming={argsStreaming ? 'true' : undefined}
        label={progressLabel}
        // The row's state glyph already carries the live mark; a second one
        // here would put two `[data-live="true"]` elements on one step.
        showMark={false}
        textClassName="truncate"
      />
    );
  }
  if (!durationLabel) {
    return null;
  }
  return (
    <span
      className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
      title="Execution time"
    >
      {durationLabel}
    </span>
  );
}

/**
 * Structured run_python result region (BST-1070). Split out of ToolFallback
 * for the same cognitive-complexity reason as LiveShellOutputRegion below.
 */
function RunPythonResultRegion({
  isRunning,
  result,
}: {
  isRunning: boolean;
  result: RunPythonDisplayResult | null;
}): ReactNode {
  if (!result || isRunning) {
    return null;
  }
  return <RunPythonResultSurface result={result} />;
}

/**
 * Live incremental output while a shell command runs. Once it finishes, the
 * captured output lives in the collapsible Result pane, so this only renders
 * during execution (transient — absent on a reloaded thread). Split out of
 * ToolFallback so its own hook + condition don't add to that component's
 * cognitive complexity.
 */
function LiveShellOutputRegion({
  isRunning,
  toolCallId,
}: {
  isRunning: boolean;
  toolCallId: string;
}): ReactNode {
  const shellOutput = useShellOutput(toolCallId);
  if (!(isRunning && shellOutput && shellOutput.text.length > 0)) {
    return null;
  }
  return <LiveShellOutputPane text={shellOutput.text} truncated={shellOutput.truncated} />;
}

/**
 * Per-card undo control for the four agent mutation tools. Renders nothing when
 * there is no journal entry for this tool call (web / not-yet-journaled) — pure
 * capability gating, never a disabled stub. States: revertible → confirm →
 * revert; already reverted → disabled "Reverted"; non-revertible capture →
 * disabled with a reason tooltip; conflict response → inline "Revert anyway?".
 */
function CheckpointRevertButton({
  toolCallId,
  toolName,
}: {
  toolCallId: string;
  toolName: string;
}): ReactElement | null {
  const checkpoint = useCheckpointForToolCall(toolCallId);
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'reverting' | 'conflict'>('idle');

  if (!(checkpoint && REVERTIBLE_MUTATION_TOOL_NAMES.has(toolName))) {
    return null;
  }
  const { availability, entry, revert } = checkpoint;

  if (entry.revertedAt) {
    return (
      <span
        className="shrink-0 text-[11px] text-muted-foreground"
        data-testid="checkpoint-reverted"
      >
        Reverted
      </span>
    );
  }

  // Legacy content-era refusals first (pre-snapshot rows recorded with a
  // non-restorable capture status), then snapshot availability (BST-1164 T4:
  // no turn-start snapshot covers this edit — visibly disabled, never a
  // click-time surprise).
  const unavailableReason = isRevertibleCaptureStatus(entry.captureStatus)
    ? availability.restorable
      ? null
      : availability.reason
    : `capture status "${entry.captureStatus}" has no restorable state.`;
  if (unavailableReason !== null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            data-testid="checkpoint-unrevertible"
          >
            Can't restore
          </span>
        </TooltipTrigger>
        <TooltipContent>{unavailableReason}</TooltipContent>
      </Tooltip>
    );
  }

  const runRevert = async (force: boolean): Promise<void> => {
    setPhase('reverting');
    const result = await revert(force ? { force: true } : undefined);
    if (result.ok) {
      setPhase('idle');
      return;
    }
    setPhase(result.code === 'conflict' ? 'conflict' : 'idle');
  };

  if (phase === 'conflict') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[11px]">
        <span className="text-muted-foreground">Changed since —</span>
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-revert-anyway"
          onClick={() => runRevert(true)}
          size="sm"
          variant="ghost"
        >
          Revert anyway
        </Button>
      </span>
    );
  }

  if (phase === 'confirm') {
    return (
      <span className="flex shrink-0 items-center gap-1">
        <Button
          className="h-5 px-1.5 text-[11px]"
          data-testid="checkpoint-revert-confirm"
          onClick={() => runRevert(false)}
          size="sm"
          variant="ghost"
        >
          Confirm restore
        </Button>
        <Button
          className="h-5 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => setPhase('idle')}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={`Revert ${toolName}`}
          className="h-5 shrink-0 gap-1 px-1.5 text-[11px]"
          data-testid="checkpoint-revert"
          disabled={phase === 'reverting'}
          onClick={() => setPhase('confirm')}
          size="sm"
          variant="ghost"
        >
          <Undo2 className="size-3" />
          Revert
        </Button>
      </TooltipTrigger>
      {/* Turn-start semantics (BST-1164 T4): the snapshot engine restores the
          file to its state when the turn began, not to just-before-this-edit. */}
      <TooltipContent>Restore this file to its state at turn start</TooltipContent>
    </Tooltip>
  );
}

function ToolDetailLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
      {children}
    </p>
  );
}

/**
 * The expanded args/result panes, plus a developer-only metadata block.
 * Serializes the result HERE (memoized) rather than in ToolFallback: this
 * pane only mounts while expanded, so collapsed cards — which still re-render
 * with the streaming turn — never pay the multi-KB JSON.stringify.
 */
function ToolDetailsPane({
  argsText,
  detailsId,
  hasResult,
  isError,
  result,
  showRawIo,
  toolCallId,
  toolName,
}: {
  argsText: string | undefined;
  detailsId: string;
  hasResult: boolean;
  isError: boolean;
  result: ToolResult;
  showRawIo: boolean;
  toolCallId: string;
  toolName: string;
}) {
  const formattedResult = useMemo(
    () => (hasResult ? formatResult(result) : undefined),
    [hasResult, result]
  );
  return (
    <div className="flex flex-col gap-1.5 border-t pt-1.5" id={detailsId}>
      {showRawIo ? (
        <div className="px-2 py-1">
          <ToolDetailLabel>Metadata:</ToolDetailLabel>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            <dt className="text-muted-foreground">toolCallId</dt>
            <dd className="min-w-0 break-words text-foreground/90">{toolCallId}</dd>
            <dt className="text-muted-foreground">tool</dt>
            <dd className="min-w-0 break-words text-foreground/90">{toolName}</dd>
          </dl>
        </div>
      ) : null}
      {argsText ? (
        <div className="px-2 py-1">
          <ToolDetailLabel>Arguments:</ToolDetailLabel>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1.5 font-mono text-[11px] leading-relaxed">
            {argsText}
          </pre>
        </div>
      ) : null}
      {hasResult && !isError ? (
        <div className="px-2 pb-2">
          <ToolDetailLabel>Result:</ToolDetailLabel>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-1.5 font-mono text-[11px] leading-relaxed">
            {formattedResult}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
