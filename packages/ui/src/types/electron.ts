import type { PanelPersistenceState } from './panel';

export type LayoutElectronAPI = {
  saveLayout: (state: PanelPersistenceState) => Promise<void>;
  loadLayout: () => Promise<PanelPersistenceState | undefined>;
};
