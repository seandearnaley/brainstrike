import type { PanelPersistenceState } from './panel';

export interface LayoutElectronAPI {
  saveLayout: (state: PanelPersistenceState) => Promise<void>;
  loadLayout: () => Promise<PanelPersistenceState | undefined>;
}
