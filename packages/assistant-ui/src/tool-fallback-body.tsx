import { type ReactNode, useMemo } from 'react';
import type { ActivityStepState } from './activity-trace-model';
import { LiveShellOutputPane } from './live-shell-output-pane';
import { RunPythonResultSurface } from './run-python-result';
import type { RunPythonDisplayResult } from './run-python-result-model';
import { useShellOutput } from './shell-output-context';
import { formatResult, type ToolResult } from './tool-fallback-state';

/**
 * Everything the tool card renders BELOW its step row, in DOM order: the
 * inline error line, the live shell output pane, the structured `run_python`
 * surface, and the collapsible args/result details pane.
 *
 * Split out of `tool-fallback.tsx` (BST-1684). Each region keeps its own
 * mounting condition — in particular the details pane still mounts only while
 * expanded, so a collapsed card never pays the result serialization.
 */
export function ToolFallbackBody({
  argsText,
  collapsed,
  detailsId,
  errorMessage,
  glyphState,
  hasResult,
  result,
  runPythonResult,
  showDetails,
  showRawIo,
  toolCallId,
  toolName,
}: {
  readonly argsText: string | undefined;
  readonly collapsed: boolean;
  readonly detailsId: string;
  readonly errorMessage: string | undefined;
  /** The card's state; the body reads only its `running` / `failed` arms. */
  readonly glyphState: ActivityStepState;
  readonly hasResult: boolean;
  readonly result: ToolResult;
  readonly runPythonResult: RunPythonDisplayResult | null;
  readonly showDetails: boolean;
  readonly showRawIo: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
}): ReactNode {
  const isRunning = glyphState === 'running';
  const isError = glyphState === 'failed';
  return (
    <>
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

      {showDetails && !collapsed ? (
        <ToolDetailsPane
          argsText={argsText}
          detailsId={detailsId}
          hasResult={hasResult}
          isError={isError}
          result={result}
          showRawIo={showRawIo}
          toolCallId={toolCallId}
          toolName={toolName}
        />
      ) : null}
    </>
  );
}

/**
 * Structured run_python result region (BST-1070). Split out of the body for
 * the same cognitive-complexity reason as LiveShellOutputRegion below.
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
 * during execution (transient — absent on a reloaded thread). Split out so its
 * own hook + condition don't add to the body's cognitive complexity.
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
  readonly argsText: string | undefined;
  readonly detailsId: string;
  readonly hasResult: boolean;
  readonly isError: boolean;
  readonly result: ToolResult;
  readonly showRawIo: boolean;
  readonly toolCallId: string;
  readonly toolName: string;
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
