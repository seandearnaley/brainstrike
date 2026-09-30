/**
 * MCP Configuration Alert
 *
 * Warning banner displayed when MCP config file is missing.
 * Provides actions to select, reset, or create a sample config.
 */

import { Button } from '@brainstrike/ui';
import { AlertTriangle, FileJson, FolderOpen, RotateCcw, X } from 'lucide-react';
import type { McpConfigInfo } from './types';

/**
 * Props for McpConfigAlert component.
 */
export interface McpConfigAlertProps {
  /** Current MCP config info (null = loading) */
  configInfo: McpConfigInfo | null;
  /** Callback to create a sample config file */
  onCreateSample?: (() => Promise<void>) | undefined;
  /** Callback when alert is dismissed */
  onDismiss?: () => void;
  /** Callback to reset config to default path */
  onResetConfig: () => Promise<void>;
  /** Callback to open file selector for config */
  onSelectConfig: () => Promise<void>;
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
  onDismiss,
}: McpConfigAlertProps) {
  // Don't render if loading or config exists
  if (configInfo === null || configInfo.exists) {
    return null;
  }

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3"
      data-testid="mcp-config-alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />

      <div className="min-w-0 flex-1">
        <p className="text-sm text-warning">
          MCP config not found
          {configInfo.path && (
            <code className="ml-1.5 rounded bg-yellow-500/10 px-1 py-0.5 font-mono text-[11px]">
              {configInfo.path}
            </code>
          )}
        </p>

        <div className="mt-2 flex flex-wrap gap-2">
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

      {onDismiss && (
        <Button
          className="h-6 w-6 shrink-0 p-0"
          data-testid="dismiss-alert"
          onClick={onDismiss}
          size="sm"
          variant="ghost"
        >
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Dismiss</span>
        </Button>
      )}
    </div>
  );
}

export default McpConfigAlert;
