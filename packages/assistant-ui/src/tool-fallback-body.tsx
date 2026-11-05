import { CopyTextButton, cn } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import type { ActivityStepState } from './activity-trace-model';
import { CanvasLinkChip } from './canvas-link-chip';
import { readCanvasMutationResult } from './canvas-result-model';
import { DETAIL_LABEL_CLASS } from './detail-label';
import { LiveShellOutputPane } from './live-shell-output-pane';
import { RunPythonResultSurface } from './run-python-result';
import type { RunPythonDisplayResult } from './run-python-result-model';
import { useShellOutput } from './shell-output-context';
import { formatToolArguments, formatToolResult, type ToolResult } from './tool-fallback-state';

/**
 * Everything the tool card renders BELOW its step row, in DOM order: the
 * inline error line, the live shell output pane, the structured `run_python`
 * surface, the canvas link chip, and the collapsible args/result details pane.
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
        <p className="text-destructive px-2 pb-1 text-xs">{errorMessage}</p>
      ) : null}

      <LiveShellOutputRegion isRunning={isRunning} toolCallId={toolCallId} />

      {/* Structured run_python result (BST-1070): state-honest header + output
          panes. The raw result object stays available in the details pane. */}
      <RunPythonResultRegion isRunning={isRunning} result={runPythonResult} />

      {/* canvas://<id> chip for a settled manageCanvas write (approach plan D2). */}
      <CanvasResultRegion isRunning={isRunning} result={result} toolName={toolName} />

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
 * The `canvas://<id>` chip under a settled manageCanvas create/update/rewrite.
 * Reads the result shape (tool-name gated) rather than a `by_name` entry so a
 * hydrated card with the sanitized tool name renders it too.
 */
function CanvasResultRegion({
  isRunning,
  result,
  toolName,
}: {
  isRunning: boolean;
  result: ToolResult;
  toolName: string;
}): ReactNode {
  const canvas = readCanvasMutationResult(toolName, result);
  if (!canvas || isRunning) {
    return null;
  }
  return <CanvasLinkChip canvasId={canvas.canvasId} version={canvas.version} />;
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
  return (
    <LiveShellOutputPane
      omittedBytes={shellOutput.omittedBytes}
      text={shellOutput.text}
      truncated={shellOutput.truncated}
    />
  );
}

function ToolDetailLabel({ children }: { children: ReactNode }) {
  return <p className={cn(DETAIL_LABEL_CLASS, 'mb-1')}>{children}</p>;
}

/** A pane label with a Copy button for the pane's text, on one line. */
function ToolDetailHeader({
  children,
  copyLabel,
  text,
}: {
  readonly children: ReactNode;
  readonly copyLabel: string;
  readonly text: string;
}) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <p className={DETAIL_LABEL_CLASS}>{children}</p>
      <CopyTextButton ariaLabel={copyLabel} className="h-6 px-1.5" text={text} />
    </div>
  );
}

/**
 * The expanded args/result panes, plus a developer-only metadata block.
 * Formats the arguments and result HERE (memoized) rather than in ToolFallback: this
 * pane only mounts while expanded, so collapsed cards — which still re-render
 * with the streaming turn — never pay the multi-KB JSON parse and stringify.
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
  const formattedArgs = argsText ? formatToolArguments(argsText) : undefined;
  const formattedResult = hasResult ? formatToolResult(result) : undefined;
  return (
    <div className="flex flex-col gap-1.5 border-t pt-1.5" id={detailsId}>
      {showRawIo ? (
        <div className="px-2 py-1">
          <ToolDetailLabel>Metadata</ToolDetailLabel>
          <dl className="text-2xs grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
            <dt className="text-muted-foreground">toolCallId</dt>
            <dd className="text-foreground/90 min-w-0 break-words">{toolCallId}</dd>
            <dt className="text-muted-foreground">tool</dt>
            <dd className="text-foreground/90 min-w-0 break-words">{toolName}</dd>
          </dl>
        </div>
      ) : null}
      {formattedArgs === undefined ? null : (
        <div className="px-2 py-1">
          <ToolDetailHeader copyLabel="Copy arguments" text={formattedArgs}>
            Arguments
          </ToolDetailHeader>
          <pre className="bg-muted/40 text-2xs max-h-48 overflow-auto rounded p-1.5 font-mono leading-relaxed break-words whitespace-pre-wrap">
            {formattedArgs}
          </pre>
        </div>
      )}
      {formattedResult === undefined || isError ? null : (
        <div className="px-2 pb-2">
          <ToolDetailHeader copyLabel="Copy result" text={formattedResult}>
            Result
          </ToolDetailHeader>
          <pre className="bg-muted/40 text-2xs max-h-64 overflow-auto rounded p-1.5 font-mono leading-relaxed break-words whitespace-pre-wrap">
            {formattedResult}
          </pre>
        </div>
      )}
    </div>
  );
}
