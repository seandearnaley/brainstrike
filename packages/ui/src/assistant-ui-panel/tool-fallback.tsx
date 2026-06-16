import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, CircleDashed } from 'lucide-react';
import { type ComponentProps, type ReactElement, useId, useMemo, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { resolveToolDisplayPolicy } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import {
  categoryTintClasses,
  classifyToolName,
  isInternalToolName,
} from './tool-visual-classification';

type ToolFallbackProps = ComponentProps<ToolCallMessagePartComponent>;
type ToolStatus = ToolFallbackProps['status'];
type ToolResult = ToolFallbackProps['result'];

type DisplayStatus = 'running' | 'error' | 'success' | 'unknown';

const STATUS_LABELS: Record<DisplayStatus, string> = {
  error: 'Failed',
  running: 'Running',
  success: 'Completed',
  unknown: 'Unknown',
};

const STATUS_ICONS: Record<DisplayStatus, ReactElement> = {
  running: <CircleDashed className="size-4 text-muted-foreground" />,
  error: <AlertCircle className="size-4 text-destructive" />,
  success: <CheckCircle className="size-4 text-green-600 dark:text-green-500" />,
  unknown: <CheckCircle className="size-4 text-muted-foreground" />,
};

const isIncompleteStatus = (
  status: ToolStatus
): status is ToolStatus & { type: 'incomplete'; error?: unknown; reason?: unknown } =>
  status.type === 'incomplete';

const readResultErrorMessage = (result: ToolResult): string | undefined => {
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
  if (record['isError'] === true) {
    return 'Tool execution failed.';
  }
  return;
};

const resolveDisplayStatus = (
  status: ToolStatus,
  hasResult: boolean,
  result: ToolResult
): DisplayStatus => {
  if (status.type === 'running') {
    return 'running';
  }
  if (status.type === 'incomplete') {
    return 'error';
  }
  if (readResultErrorMessage(result)) {
    return 'error';
  }
  if (hasResult) {
    return 'success';
  }
  return 'unknown';
};

const resolveErrorMessage = (status: ToolStatus, result: ToolResult): string | undefined => {
  if (!isIncompleteStatus(status)) {
    return readResultErrorMessage(result);
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

/**
 * Argument keys most likely to identify WHAT a tool accessed, in priority
 * order. The first string-valued match is surfaced inline in the card header
 * so users can read "which file / which query" without expanding details.
 */
const PRIMARY_ARG_KEYS = [
  'query',
  'q',
  'pattern',
  'path',
  'filePath',
  'file',
  'url',
  'name',
  'id',
  'command',
] as const;

const MAX_PRIMARY_ARG_LENGTH = 120;

export function extractPrimaryArg(args: unknown, argsText: string | undefined): string | undefined {
  let record: Record<string, unknown> | undefined;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    record = args as Record<string, unknown>;
  } else if (argsText) {
    try {
      const parsed: unknown = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      return;
    }
  }
  if (!record) {
    return;
  }

  for (const key of PRIMARY_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return truncatePrimaryArg(value);
    }
  }
  const firstString = Object.values(record).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return firstString ? truncatePrimaryArg(firstString) : undefined;
}

function truncatePrimaryArg(value: string): string {
  const singleLine = value.replaceAll(/\s+/g, ' ').trim();
  return singleLine.length > MAX_PRIMARY_ARG_LENGTH
    ? `${singleLine.slice(0, MAX_PRIMARY_ARG_LENGTH)}…`
    : singleLine;
}

/**
 * Compact "what came back" summary for the header: item counts for arrays and
 * common collection-shaped results. Returns undefined when there is nothing
 * meaningful to count (the expanded Result pane remains the full view).
 */
const COLLECTION_RESULT_KEYS = ['matches', 'results', 'items', 'files', 'chunks', 'rows'] as const;

export function summarizeResult(result: ToolResult): string | undefined {
  if (Array.isArray(result)) {
    return `${result.length} ${result.length === 1 ? 'item' : 'items'}`;
  }
  if (!(result && typeof result === 'object')) {
    return;
  }
  const record = result as Record<string, unknown>;
  for (const key of COLLECTION_RESULT_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return `${value.length} ${key}`;
    }
  }
  return;
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
export const ToolFallback: ToolCallMessagePartComponent = ({
  toolCallId,
  toolName,
  args,
  argsText,
  result,
  status,
}) => {
  const { detailLevel } = useAssistantDetailLevel();
  const policy = resolveToolDisplayPolicy(detailLevel, {
    isInternal: isInternalToolName(toolName),
  });

  const [isCollapsed, setIsCollapsed] = useState(!policy.defaultExpanded);
  const detailsId = useId();

  const hasResult = result !== undefined;
  const displayStatus = resolveDisplayStatus(status, hasResult, result);
  const statusIcon = STATUS_ICONS[displayStatus];
  const statusText = STATUS_LABELS[displayStatus];
  const isRunning = displayStatus === 'running';
  const isError = displayStatus === 'error';
  const errorMessage = resolveErrorMessage(status, result);
  const showDetails = policy.showDetailsExpander && !isRunning && (Boolean(argsText) || hasResult);
  const formattedResult = hasResult ? formatResult(result) : undefined;

  const primaryArg = useMemo(() => extractPrimaryArg(args, argsText), [args, argsText]);
  const resultSummary = useMemo(
    () => (isError || !policy.showResultSummary ? undefined : summarizeResult(result)),
    [isError, policy.showResultSummary, result]
  );

  const category = classifyToolName(toolName);
  const tint = categoryTintClasses(category);

  return (
    <div
      className={`bs-tool-timeline my-1.5 rounded-lg border ${
        isError ? 'border-destructive/50 bg-destructive/5' : tint.card
      }`}
      data-testid="tool-fallback"
      data-tool-category={category}
    >
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
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
              title={primaryArg}
            >
              {primaryArg}
            </span>
          ) : null}
        </span>
        {isRunning ? (
          <AssistantThinkingIndicator
            className="shrink-0 text-xs"
            markClassName="size-3.5"
            textClassName="truncate"
          />
        ) : null}
        {resultSummary ? (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {resultSummary}
          </span>
        ) : null}
        {showDetails && (
          <Button
            aria-controls={isCollapsed ? undefined : detailsId}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand details' : 'Collapse details'}
            className="size-6 shrink-0 text-muted-foreground"
            onClick={() => setIsCollapsed((prev) => !prev)}
            size="icon"
            title={isCollapsed ? 'Expand details' : 'Collapse details'}
            variant="ghost"
          >
            {isCollapsed ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronUp className="size-3.5" />
            )}
          </Button>
        )}
      </div>

      {isError && errorMessage ? (
        <p className="px-2.5 pb-1.5 text-destructive text-xs">{errorMessage}</p>
      ) : null}

      {showDetails && !isCollapsed && (
        <div className="flex flex-col gap-2 border-t pt-2" id={detailsId}>
          {policy.showRawIo ? (
            <div className="px-3 py-1">
              <p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Metadata:
              </p>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                <dt className="text-muted-foreground">toolCallId</dt>
                <dd className="min-w-0 break-words text-foreground/90">{toolCallId}</dd>
                <dt className="text-muted-foreground">tool</dt>
                <dd className="min-w-0 break-words text-foreground/90">{toolName}</dd>
              </dl>
            </div>
          ) : null}
          {argsText && (
            <div className="px-3 py-1">
              <p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Arguments:
              </p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {argsText}
              </pre>
            </div>
          )}
          {hasResult && !isError && (
            <div className="px-3 pb-2">
              <p className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                Result:
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {formattedResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

ToolFallback.displayName = 'ToolFallback';
