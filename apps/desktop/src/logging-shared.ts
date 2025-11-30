import type { LoggingPreferences } from '@brainstrike/utils';

export type LoggingCapabilities = {
  runtime: 'electron';
  fileLoggingSupported: boolean;
  canSelectDestination: boolean;
  defaultDestination: string | null;
  reason?: string | null;
};

export type LoggingSettingsPayload = {
  preferences: LoggingPreferences;
  capabilities: LoggingCapabilities;
};
