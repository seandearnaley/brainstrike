/**
 * MCP Configuration Alert
 *
 * Warning banner displayed when MCP config file is missing.
 * Provides actions to select, reset, or create a sample config.
 */

import { Button } from '@brainstrike/ui';
import { AlertTriangle, FileJson, FolderOpen, RotateCcw } from 'lucide-react';
import type { McpConfigInfo } from './types';

/**
 * Props for McpConfigAlert component.
 */
export interface McpConfigAlertProps {
  /** Current MCP config info (null = loading) */
  configInfo: McpConfigInfo | null;
  /** Callback to open file selector for config */
  onSelectConfig: () => Promise<void>;
  /** Callback to reset config to default path */
  onResetConfig: () => Promise<void>;
  /** Callback to create a sample config file */
  onCreateSample?: (() => Promise<void>) | undefined;
}

/**
 * MCP Configuration Alert Component
 *
 * Displays a warning banner when the MCP config file is missing,
 * providing quick actions to resolve the issue.
 */
export function McpConfigAlert({
  configInfo,
  onSelectConfig,
  onResetConfig,
  onCreateSample,
}: McpConfigAlertProps) {
  // Don't render if loading or config exists
  if (configInfo === null || configInfo.exists) {
    return null;
  }

  return (
    <div
      className="rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-4"
      data-testid="mcp-config-alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-yellow-600 dark:text-yellow-500" />
        <div className="min-w-0 flex-1">
          <h4 className="font-medium text-sm text-yellow-800 dark:text-yellow-200">
            MCP Configuration Missing
          </h4>
          <p className="mt-1 text-xs text-yellow-700 dark:text-yellow-300">
            No MCP configuration file found. MCP tools will not be available until a valid config is
            provided.
          </p>
          {configInfo.path && (
            <p className="mt-1.5 text-xs text-yellow-600 dark:text-yellow-400">
              Expected at:{' '}
              <code className="rounded bg-yellow-500/10 px-1 py-0.5 font-mono text-[10px]">
                {configInfo.path}
              </code>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              className="h-7 gap-1.5 px-2.5 text-xs"
              data-testid="select-config-btn"
              onClick={onSelectConfig}
              size="sm"
              variant="outline"
            >
              <FolderOpen className="h-3 w-3" />
              Select Config File
            </Button>
            <Button
              className="h-7 gap-1.5 px-2.5 text-xs"
              data-testid="reset-config-btn"
              onClick={onResetConfig}
              size="sm"
              variant="ghost"
            >
              <RotateCcw className="h-3 w-3" />
              Reset to Default
            </Button>
            {onCreateSample && (
              <Button
                className="h-7 gap-1.5 px-2.5 text-xs"
                data-testid="create-sample-btn"
                onClick={onCreateSample}
                size="sm"
                variant="ghost"
              >
                <FileJson className="h-3 w-3" />
                Create Sample Config
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default McpConfigAlert;
