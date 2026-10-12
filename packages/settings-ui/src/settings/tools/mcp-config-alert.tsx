/**
 * MCP configuration setup guidance
 *
 * Shown while the MCP config file does not exist — the normal state of a fresh
 * profile, so it is neutral setup guidance rather than a warning (BST-1981).
 * Provides actions to select, reset, or create a sample config.
 */

import { Button } from '@brainstrike/ui';
import { FileJson, FolderOpen, Info, RotateCcw, X } from 'lucide-react';
import { useId } from 'react';
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
 * Names where MCP servers are read from and offers the ways to start, while
 * no config file exists yet.
 */
export function McpConfigAlert({
  configInfo,
  onSelectConfig,
  onResetConfig,
  onCreateSample,
  onDismiss,
}: McpConfigAlertProps) {
  const titleId = useId();
  // Don't render if loading or config exists
  if (configInfo === null || configInfo.exists) {
    return null;
  }

  return (
    <section
      aria-labelledby={titleId}
      className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3"
      data-testid="mcp-config-alert"
    >
      <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

      <div className="min-w-0 flex-1">
        <h3 className="font-medium text-sm" id={titleId}>
          No MCP servers configured yet
        </h3>
        <p className="mt-0.5 text-muted-foreground text-xs">
          MCP servers are read from
          {configInfo.path ? (
            <code className="mx-1 break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
              {configInfo.path}
            </code>
          ) : (
            ' a config file '
          )}
          once it exists. Create a sample config to start, or select an existing file.
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
    </section>
  );
}

export default McpConfigAlert;
