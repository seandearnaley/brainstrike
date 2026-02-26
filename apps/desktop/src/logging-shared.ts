import type { LoggingPreferences } from '@brainstrike/utils';

export interface LoggingCapabilities {
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
