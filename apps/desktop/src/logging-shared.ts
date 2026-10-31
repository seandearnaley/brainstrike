import type { LoggingPreferences } from '@brainstrike/logging';

interface LoggingCapabilities {
  canSelectDestination: boolean;
  defaultDestination: string | null;
  fileLoggingSupported: boolean;
  reason?: string | null;
  runtime: 'electron';
}

export interface LoggingSettingsPayload {
  capabilities: LoggingCapabilities;
  /** What Restore Defaults commits: Main's defaults, sanitized as a commit would be. */
  defaults: LoggingPreferences;
  preferences: LoggingPreferences;
}
