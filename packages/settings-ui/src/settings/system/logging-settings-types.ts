import type { LoggingPreferences } from '@brainstrike/logging';
import type { LogSourceAdapter } from './log-viewer-components/log-source-adapter';

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
  durableLogSource?: LogSourceAdapter;
  fileCapabilities?: FileCapabilities;
  logSource?: LogSourceAdapter;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  /**
   * Standalone to avoid importing app-shell back into settings-ui. Callers
   * backed by `useDurableLogSource()` pass `() => durableLogSource.exportNdjson()`.
   */
  onExportDurableNdjson?: () => Promise<DurableNdjsonExportResult>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  /**
   * Standalone to avoid an app-shell cycle. When absent, retention selectors
   * remain visible and only the "Purge now" row is omitted.
   */
  onPurgeNow?: () => Promise<number>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
  onSelectLogDestination?: () => Promise<string | null>;
  runtime: 'browser' | 'electron-renderer';
  /**
   * The only user-visible path for a broken durable sink. Sink-scope records
   * are deliberately excluded from both converters to prevent feedback loops,
   * so omitting this would silently make a disabled sink look healthy and empty.
   */
  sinkHealthReason?: string | null;
}
