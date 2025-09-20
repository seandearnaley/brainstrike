import { type FC, useState } from 'react';

interface ToolFallbackProps {
  toolName: string;
  argsText: string;
  result?: unknown;
  status?: {
    type: 'running' | 'complete' | 'incomplete' | 'requires-action';
    reason?: string;
    error?: unknown;
  };
}

export const ToolFallback: FC<ToolFallbackProps> = ({ toolName, argsText, result, status }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isRunning = status?.type === 'running';
  const isError = status?.type === 'incomplete' && status?.reason === 'error';
  const isComplete = status?.type === 'complete';

  return (
    <div
      data-testid="tool-part"
      data-tool={toolName}
      className="tool-card rounded-lg border border-gray-200 bg-gray-50 p-4 my-2"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">Tool: {toolName}</span>
          {isRunning && (
            <span className="text-xs px-2 py-1 rounded bg-blue-100 text-blue-700">Running...</span>
          )}
          {isComplete && (
            <span className="text-xs px-2 py-1 rounded bg-green-100 text-green-700">Complete</span>
          )}
          {isError && (
            <span className="text-xs px-2 py-1 rounded bg-red-100 text-red-700">Error</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          {isExpanded ? '▼' : '▶'}
        </button>
      </div>

      {(isExpanded || !result) && argsText && (
        <div className="mb-2">
          <div className="text-xs text-gray-500 mb-1">Arguments:</div>
          <pre className="text-xs bg-white rounded p-2 overflow-x-auto">{argsText}</pre>
        </div>
      )}

      {isRunning && (
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <div className="animate-spin h-3 w-3 border-2 border-gray-300 border-t-blue-600 rounded-full" />
          <span>Processing...</span>
        </div>
      )}

      {result !== undefined && result !== null && (
        <div>
          <div className="text-xs text-gray-500 mb-1">Result:</div>
          <pre className="text-xs bg-white rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
            {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}

      {isError && status?.error !== undefined && status?.error !== null && (
        <div className="mt-2 text-sm text-red-600">
          Error: {(() => {
            const err = status.error;
            if (err instanceof Error) return err.message;
            if (typeof err === 'string') return err;
            return 'Unknown error occurred';
          })()}
        </div>
      )}
    </div>
  );
};

ToolFallback.displayName = 'ToolFallback';
