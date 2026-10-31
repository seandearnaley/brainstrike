import type { LoggingPreferences } from '@brainstrike/logging';
import type { AppUpdatePreferences } from './ipc-domains/app-updates.contract';

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
  /** macOS: the user chose Not Now when offered the move to Applications (BST-2356). */
  moveToApplications?: {
    v1: { declined: boolean };
  };
  /** Settings › Updates (BST-2367); written before the first update check. */
  updatePreferences?: {
    v1: AppUpdatePreferences;
  };
  windowState?: {
    v1: DesktopWindowState;
  };
}
