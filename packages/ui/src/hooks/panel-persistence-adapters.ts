import { getElectronAPI } from '../lib/electron-utils';
import type { PanelPersistenceState } from '../types/panel';

export interface PanelPersistenceAdapter {
  load: () => Promise<PanelPersistenceState | null>;
  save: (state: PanelPersistenceState) => Promise<void>;
  flush?: () => Promise<void>;
}

const STORAGE_KEY = 'panelLayout.v1';

export class LocalStoragePanelPersistenceAdapter implements PanelPersistenceAdapter {
  async load(): Promise<PanelPersistenceState | null> {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PanelPersistenceState) : null;
    } catch {
      return null;
    }
  }

  async save(state: PanelPersistenceState): Promise<void> {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async flush(): Promise<void> {
    // Nothing to flush for localStorage
  }
}

export class ElectronPanelPersistenceAdapter implements PanelPersistenceAdapter {
  async load(): Promise<PanelPersistenceState | null> {
    try {
      const api = getElectronAPI();
      const loaded = await api?.loadLayout?.();
      return loaded ?? null;
    } catch {
      return null;
    }
  }

  async save(state: PanelPersistenceState): Promise<void> {
    const api = getElectronAPI();
    if (api?.saveLayout) {
      await api.saveLayout(state);
    }
  }

  async flush(): Promise<void> {
    // No explicit flush API; noop
  }
}

// Phase 3: remove automatic detection; require explicit adapter selection by the app
