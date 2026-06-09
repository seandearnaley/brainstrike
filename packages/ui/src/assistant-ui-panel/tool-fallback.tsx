import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  Wrench,
} from 'lucide-react';
import * as m from 'motion/react-m';
import { type ComponentProps, type ReactElement, useId, useState } from 'react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { AssistantThinkingIndicator } from './assistant-thinking-indicator';
import { categoryTintClasses, classifyToolName } from './tool-visual-classification';

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

const getToolHeading = (toolName: string, displayStatus: DisplayStatus): string => {
  if (displayStatus === 'running') {
    return `Using ${toolName}`;
  }
  if (displayStatus === 'error') {
    return `Tool failed: ${toolName}`;
  }
  return `Used ${toolName}`;
};

/**
 * ToolFallback component displays tool execution status and results.
 *
 * Handles three states:
 * - Running: Tool is being executed (shows loader)
 * - Success: Tool executed successfully (shows result)
 * - Error: Tool execution failed (shows error message in red)
 */
export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(true);
  const detailsId = useId();

  const hasResult = result !== undefined;
  const displayStatus = resolveDisplayStatus(status, hasResult, result);
  const statusIcon = STATUS_ICONS[displayStatus];
  const statusText = STATUS_LABELS[displayStatus];
  const isRunning = displayStatus === 'running';
  const isError = displayStatus === 'error';
  const errorMessage = resolveErrorMessage(status, result);
  const showDetails = !isRunning && (Boolean(argsText) || hasResult);
  const formattedResult = hasResult ? formatResult(result) : undefined;
  const heading = getToolHeading(toolName, displayStatus);

  const category = classifyToolName(toolName);
  const tint = categoryTintClasses(category);

  return (
    <m.div
      className={`bs-tool-timeline my-1.5 rounded-lg border ${
        isError ? 'border-destructive/50 bg-destructive/5' : tint.card
      }`}
      data-testid="tool-fallback"
      data-tool-category={category}
      layout
      transition={{ duration: 0.16, ease: 'easeOut' }}
    >
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-3 px-3 py-2">
        <div
          aria-hidden="false"
          className={`bs-tool-timeline-rail ${isError ? 'text-destructive' : tint.rail}`}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-label={statusText} className="inline-flex" role="img">
                {statusIcon}
              </span>
            </TooltipTrigger>
            <TooltipContent>{statusText}</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-w-0">
          <p className={`font-medium text-sm ${isError ? 'text-destructive' : ''}`}>
            <span className="inline-flex items-center gap-1.5">
              <Wrench className="size-3.5 text-muted-foreground" />
              <span>{heading}</span>
            </span>
          </p>
          {isRunning ? (
            <AssistantThinkingIndicator className="mt-1 text-xs" markClassName="size-3.5" />
          ) : null}
          {isError && errorMessage ? (
            <p className="mt-1 text-destructive text-xs">{errorMessage}</p>
          ) : null}
        </div>
        {showDetails && (
          <Button
            aria-controls={isCollapsed ? undefined : detailsId}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? 'Expand details' : 'Collapse details'}
            className="size-8"
            onClick={() => setIsCollapsed((prev) => !prev)}
            size="icon"
            title={isCollapsed ? 'Expand details' : 'Collapse details'}
            variant="ghost"
          >
            {isCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </Button>
        )}
      </div>

      {showDetails && !isCollapsed && (
        <div className="flex flex-col gap-2 border-t pt-2" id={detailsId}>
          {argsText && (
            <div className="px-4 py-2">
              <p className="mb-1 font-medium text-muted-foreground text-xs">Arguments:</p>
              <pre className="whitespace-pre-wrap text-xs">{argsText}</pre>
            </div>
          )}
          {hasResult && !isError && (
            <div className="border-t border-dashed px-4 py-2">
              <p className="mb-1 font-medium text-muted-foreground text-xs">Result:</p>
              <pre className="whitespace-pre-wrap text-xs">{formattedResult}</pre>
            </div>
          )}
        </div>
      )}
    </m.div>
  );
};

ToolFallback.displayName = 'ToolFallback';
