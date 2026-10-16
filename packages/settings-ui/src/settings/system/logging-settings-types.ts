import type { LoggingPreferences } from '@brainstrike/logging';

export interface DurableNdjsonExportResult {
  readonly exportedCount: number;
  readonly ndjson: string;
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface FileCapabilities {
  canSelectDestination: boolean;
  defaultDestination?: string | null;
  fileLoggingSupported: boolean;
  reason?: string | null;
}

/**
 * Callback-only capabilities supplied by app-shell. Keeping these structural
 * contracts here avoids the circular dependency that importing app-shell or
 * the diagnostic repository into settings-ui would create.
 */
export interface LoggingSettingsSectionProps {
  busy?: boolean;
  fileCapabilities?: FileCapabilities;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  /** Opens the Logs workspace tab, where the log viewer lives (BST-1791). */
  onOpenLogs?: () => void;
  /**
   * Standalone to avoid an app-shell cycle. When absent, retention selectors
   * remain visible and only the "Purge now" row is omitted.
   */
  onPurgeNow?: () => Promise<number>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
  onSelectLogDestination?: () => Promise<string | null>;
  runtime: 'browser' | 'electron-renderer';
  /** Shown above the retention settings, which describe the durable sink. */
  sinkHealthReason?: string | null;
}
