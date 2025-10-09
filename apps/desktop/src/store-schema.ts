import type { PanelPersistenceState } from '@brainstrike/ui';
import type { LoggingPreferences } from '@brainstrike/utils';

export interface DesktopSettingsStoreSchema {
  panelLayout?: {
    v1: PanelPersistenceState;
  };
  loggingPreferences?: {
    v1: LoggingPreferences;
  };
}
