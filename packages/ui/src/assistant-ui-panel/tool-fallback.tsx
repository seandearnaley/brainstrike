import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { type ComponentProps, type ReactElement, useState } from 'react';
import { Button } from '../button';

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
  running: <Loader2 className="size-4 animate-spin text-blue-500" />,
  error: <AlertCircle className="size-4 text-destructive" />,
  success: <CheckCircle className="size-4 text-green-600 dark:text-green-500" />,
  unknown: <CheckCircle className="size-4 text-muted-foreground" />,
};

const isIncompleteStatus = (
  status: ToolStatus
): status is ToolStatus & { type: 'incomplete'; error?: unknown; reason?: unknown } =>
  status.type === 'incomplete';

const resolveDisplayStatus = (status: ToolStatus, hasResult: boolean): DisplayStatus => {
  if (status.type === 'running') {
    return 'running';
  }
  if (status.type === 'incomplete') {
    return 'error';
  }
  if (hasResult) {
    return 'success';
  }
  return 'unknown';
};

const resolveErrorMessage = (status: ToolStatus, result: ToolResult): string | undefined => {
  if (!isIncompleteStatus(status)) {
    return undefined;
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
  const [isCollapsed, setIsCollapsed] = useState(false);

  const hasResult = result !== undefined;
  const displayStatus = resolveDisplayStatus(status, hasResult);
  const statusIcon = STATUS_ICONS[displayStatus];
  const statusText = STATUS_LABELS[displayStatus];
  const isRunning = displayStatus === 'running';
  const isError = displayStatus === 'error';
  const errorMessage = resolveErrorMessage(status, result);
  const showDetails = !isRunning && (Boolean(argsText) || hasResult);
  const formattedResult = hasResult ? formatResult(result) : undefined;

  return (
    <div
      className={`my-2 rounded-lg border ${
        isError ? 'border-destructive/50 bg-destructive/5' : 'border-border'
      }`}
      data-testid="tool-fallback"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        {statusIcon}
        <div className="flex-grow">
          <p className={`text-sm font-medium ${isError ? 'text-destructive' : ''}`}>
            <span className="font-semibold">{toolName}</span>
            {' • '}
            <span className="text-xs">{statusText}</span>
          </p>
          {isError && errorMessage && (
            <p className="mt-1 text-xs text-destructive">{errorMessage}</p>
          )}
        </div>
        {showDetails && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setIsCollapsed((prev) => !prev)}
            aria-label={isCollapsed ? 'Expand details' : 'Collapse details'}
          >
            {isCollapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          </Button>
        )}
      </div>

      {showDetails && !isCollapsed && (
        <div className="flex flex-col gap-2 border-t pt-2">
          {argsText && (
            <div className="px-4 py-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Arguments:</p>
              <pre className="whitespace-pre-wrap text-xs">{argsText}</pre>
            </div>
          )}
          {hasResult && !isError && (
            <div className="border-t border-dashed px-4 py-2">
              <p className="mb-1 text-xs font-medium text-muted-foreground">Result:</p>
              <pre className="whitespace-pre-wrap text-xs">{formattedResult}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

ToolFallback.displayName = 'ToolFallback';
