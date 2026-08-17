import type { LoggingPreferences } from '@brainstrike/logging';
import type { PanelPersistenceState } from '@brainstrike/ui';

export interface DesktopWindowBounds {
  height: number;
  width: number;
  x?: number;
  y?: number;
}

export interface DesktopWindowState {
  bounds: DesktopWindowBounds;
  isFullScreen: boolean;
  isMaximized: boolean;
}

export interface DesktopSettingsStoreSchema {
  loggingPreferences?: {
    v1: LoggingPreferences;
  };
  panelLayout?: {
    v1: PanelPersistenceState;
  };
  windowState?: {
    v1: DesktopWindowState;
  };
}
