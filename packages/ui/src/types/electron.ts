import type { PanelPersistenceState } from '../hooks/use-panel-persistence';

export interface LayoutElectronAPI {
  saveLayout: (state: PanelPersistenceState) => Promise<void>;
  loadLayout: () => Promise<PanelPersistenceState | undefined>;
}
