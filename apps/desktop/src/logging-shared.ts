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
  preferences: LoggingPreferences;
}
