import type { LoggingPreferences } from '@brainstrike/utils';

export interface LoggingCapabilities {
  runtime: 'electron';
  fileLoggingSupported: boolean;
  canSelectDestination: boolean;
  defaultDestination: string | null;
  reason?: string | null;
}

export interface LoggingSettingsPayload {
  preferences: LoggingPreferences;
  capabilities: LoggingCapabilities;
}
