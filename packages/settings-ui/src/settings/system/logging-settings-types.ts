import type { LoggingPreferences } from '@brainstrike/logging';
import type { LogSourceAdapter } from './log-viewer-components/log-source-adapter';

export interface DurableNdjsonExportResult {
  readonly exportedCount: number;
  readonly ndjson: string;
  readonly totalCount: number;
  readonly truncated: boolean;
}

/**
 * Callback-only capabilities supplied by app-shell. Keeping these structural
 * contracts here avoids the circular dependency that importing app-shell or
 * the diagnostic repository into settings-ui would create.
 */
export interface LoggingSettingsSectionProps {
  busy?: boolean;
  durableLogSource?: LogSourceAdapter;
  fileCapabilities?: {
    canSelectDestination: boolean;
    defaultDestination?: string | null;
    fileLoggingSupported: boolean;
    reason?: string | null;
  };
  logSource?: LogSourceAdapter;
  onCommitPreferences?: (
    preferences: LoggingPreferences
  ) => Promise<LoggingPreferences | undefined>;
  onExportDurableNdjson?: () => Promise<DurableNdjsonExportResult>;
  onOpenLogDestination?: (target: string | null) => Promise<boolean>;
  onPurgeNow?: () => Promise<number>;
  onResetPreferences?: (preferences: LoggingPreferences) => Promise<void>;
  onSelectLogDestination?: () => Promise<string | null>;
  runtime: 'browser' | 'electron-renderer';
  sinkHealthReason?: string | null;
}
