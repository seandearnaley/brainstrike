import type { PanelPersistenceState } from './panel';

export type LayoutPersistenceResult = { success: true } | { success: false; message: string };

export type LayoutLoadResult =
  | { success: true; data: PanelPersistenceState | null }
  | { success: false; message: string };

export interface LayoutElectronAPI {
  loadLayout: () => Promise<LayoutLoadResult>;
  saveLayout: (state: PanelPersistenceState) => Promise<LayoutPersistenceResult>;
}
