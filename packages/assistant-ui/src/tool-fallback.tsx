import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { isRevertibleCaptureStatus } from '@brainstrike/assistant-contract';
import { isDeclinedToolCallResult } from '@brainstrike/assistant-contract/tool-approval';
import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CircleSlash,
  Undo2,
} from 'lucide-react';
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from 'react';
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

type DisplayStatus = 'running' | 'error' | 'stopped' | 'success' | 'unknown';

const STATUS_LABELS: Record<DisplayStatus, string> = {
  error: 'Failed',
  running: 'Running',
  stopped: 'Stopped',
  success: 'Completed',
  unknown: 'Unknown',
};

const STATUS_ICONS: Record<DisplayStatus, ReactElement> = {
  error: <AlertCircle className="size-4 text-destructive" />,
  running: <CircleDashed className="size-4 text-muted-foreground" />,
  stopped: <CircleSlash className="size-4 text-muted-foreground" />,
  success: <CheckCircle className="size-4 text-green-600 dark:text-green-500" />,
  unknown: <CheckCircle className="size-4 text-muted-foreground" />,
};

/**
 * BST-1070: the CARD-level status for a settled `run_python` result. The
 * generic path renders a green check for any error-free result, which would
 * lie for three of this tool's five states: cancelled/timed-out/killed runs
 * did not complete (design rule: cancelled NEVER renders as success) and an
 * `unavailable` result means nothing ran at all (destructive). A non-zero
 * exit stays `success` at the card level — the tool call completed; the
 * result surface right below carries the amber "finished with an error".
 */
function runPythonDisplayStatus(result: RunPythonDisplayResult): DisplayStatus {
  switch (result.kind) {
    case 'completed':
      return 'success';
    case 'unavailable':
      return 'error';
    default:
      // timed_out / killed / cancelled / network_denied / declined: the run
      // stopped without completing — network_denied and declined by the
      // user's explicit choice.
      return 'stopped';
  }
}

/**
 * Narrows a settled `run_python` result and resolves the card status in one
 * place (kept out of ToolFallback for cognitive-complexity budget). A shape
 * that fails narrowing (malformed or future) stays on the generic path with
 * the generic status — never an invented surface.
 *
 * The structured mapping only ever OVERRIDES a generic `success`: `running`
 * and `incomplete` must keep winning, or a transport abort's `status.error`
 * would vanish behind a Completed/Stopped card and a still-running call would
 * lose its thinking indicator.
 */
function resolveCardStatus(
  toolName: string,
  status: ToolStatus,
  result: ToolResult,
  isErrorResult: boolean
): { displayStatus: DisplayStatus; runPythonResult: RunPythonDisplayResult | null } {
  const hasResult = result !== undefined;
  const generic = resolveDisplayStatus(status, hasResult, result, isErrorResult);
  if (generic !== 'success') {
    // Generic path owns the card (running / incomplete / error-shaped): no
    // structured surface either, or it would render under Failed chrome.
    return { displayStatus: generic, runPythonResult: null };
  }
  const runPythonResult =
    toolName === NATIVE_TOOL_ID.runPython ? narrowRunPythonDisplayResult(result) : null;
  if (runPythonResult) {
    return { displayStatus: runPythonDisplayStatus(runPythonResult), runPythonResult };
  }
  // BST-1282: a call the user DECLINED at its approval gate settles with the
  // shared `DeclinedToolCallResult` envelope and no error flag. Left on the
  // generic path it would earn a green Completed for a tool that never ran, so
  // it takes the same muted `stopped` treatment run_python already reserves for
  // a decline — and never the destructive Failed chrome, because nothing broke.
  return {
    displayStatus: isDeclinedToolCallResult(result) ? 'stopped' : 'success',
    runPythonResult: null,
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

const resolveDisplayStatus = (
  status: ToolStatus,
  hasResult: boolean,
  result: ToolResult,
  isErrorResult: boolean
): DisplayStatus => {
  if (status.type === 'running') {
    return 'running';
  }
  if (status.type === 'incomplete') {
    return 'error';
  }
  if (readResultErrorMessage(result, isErrorResult)) {
    return 'error';
  }
  if (hasResult) {
    return 'success';
  }
  return 'unknown';
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
 * a tinted card with a single-line header (status, tool name, primary
 * argument, result summary) and collapsible Arguments/Result panes.
 *
 * Handles three states:
 * - Running: shows the thinking indicator inline (no expander yet)
 * - Success: shows result summary; details available behind the expander
 * - Error: shows the error message inline in red
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
  const { displayStatus, runPythonResult } = resolveCardStatus(
    toolName,
    status,
    result,
    isErrorResult
  );
  const statusIcon = STATUS_ICONS[displayStatus];
  const statusText = STATUS_LABELS[displayStatus];
  const isRunning = displayStatus === 'running';
  const isError = displayStatus === 'error';
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
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={statusText}
              className={`inline-flex shrink-0 ${isError ? 'text-destructive' : tint.rail}`}
              role="img"
            >
              {statusIcon}
            </span>
          </TooltipTrigger>
          <TooltipContent>{statusText}</TooltipContent>
        </Tooltip>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={`shrink-0 font-medium font-mono text-xs ${
              isError ? 'text-destructive' : 'text-foreground'
            }`}
          >
            {toolName}
          </span>
          {primaryArg ? (
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={primaryArg.full}
            >
              {primaryArg.display}
            </span>
          ) : null}
        </span>
        <ToolRunTiming
          argsStreaming={argsStreaming}
          durationLabel={durationLabel}
          isRunning={isRunning}
          progressLabel={progressLabel}
        />

        {resultSummary ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {resultSummary}
          </span>
        ) : null}
        {resolvedRootName ? (
          <span
            className="max-w-36 shrink-0 truncate text-[11px] text-muted-foreground"
            title={`Resolved workspace root: ${resolvedRootName}`}
          >
            in {resolvedRootName}
          </span>
        ) : null}
        {isRunning || isError ? null : (
          <CheckpointRevertButton toolCallId={toolCallId} toolName={toolName} />
        )}
        {showDetails ? (
          <DetailsToggleButton
            detailsId={detailsId}
            isCollapsed={isCollapsed}
            onToggle={() => setUserCollapsed(!isCollapsed)}
          />
        ) : null}
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
        // pane rather than squeeze the tool name out of its slot.
        className="min-w-0 max-w-[60%] shrink text-xs tabular-nums"
        data-args-streaming={argsStreaming ? 'true' : undefined}
        label={progressLabel}
        markClassName="size-3.5"
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

/** Expand/collapse control for a tool card's details panes. */
function DetailsToggleButton({
  detailsId,
  isCollapsed,
  onToggle,
}: {
  detailsId: string;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const label = isCollapsed ? 'Expand details' : 'Collapse details';
  return (
    <Button
      aria-controls={isCollapsed ? undefined : detailsId}
      aria-expanded={!isCollapsed}
      aria-label={label}
      className="size-6 shrink-0 text-muted-foreground"
      onClick={onToggle}
      size="icon"
      title={label}
      variant="ghost"
    >
      {isCollapsed ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
    </Button>
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
