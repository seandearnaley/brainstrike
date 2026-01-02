import type { PanelPersistenceState } from '@brainstrike/ui';
import type { LoggingPreferences } from '@brainstrike/utils';

export type DesktopWindowBounds = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

export type DesktopWindowState = {
  bounds: DesktopWindowBounds;
  isFullScreen: boolean;
  isMaximized: boolean;
};

export type DesktopSettingsStoreSchema = {
  panelLayout?: {
    v1: PanelPersistenceState;
  };
  loggingPreferences?: {
    v1: LoggingPreferences;
  };
  windowState?: {
    v1: DesktopWindowState;
  };
};
