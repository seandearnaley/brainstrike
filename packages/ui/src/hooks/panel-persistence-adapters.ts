import { createLogger } from '@brainstrike/utils/logger';
import { getElectronAPI } from '../lib/electron-utils';
import type { PanelPersistenceState } from '../types/panel';

export interface PanelPersistenceAdapter {
  flush?: () => Promise<void>;
  load: () => Promise<PanelPersistenceState | null>;
  save: (state: PanelPersistenceState) => Promise<void>;
}

const STORAGE_KEY = 'panelLayout.v1';

const logger = createLogger('PanelPersistenceAdapters');

/**
 * Deliberate degrade: an unreadable persisted layout falls back to defaults
 * (returning null lets the caller hydrate), but the discard is reported so a
 * corrupted payload is never silently eaten.
 */
function warnDiscardedState(adapter: string, reason: string): void {
  logger.warn('Discarding unreadable persisted panel state; using defaults', {
    adapter,
    error: reason,
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LocalStoragePanelPersistenceAdapter implements PanelPersistenceAdapter {
  async load(): Promise<PanelPersistenceState | null> {
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PanelPersistenceState) : null;
    } catch (error) {
      warnDiscardedState('LocalStoragePanelPersistenceAdapter', describeError(error));
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
      const result = await api?.loadLayout?.();
      if (!result) {
        // No layout bridge available: nothing was persisted to discard.
        return null;
      }
      if (!result.success) {
        warnDiscardedState('ElectronPanelPersistenceAdapter', result.message);
        return null;
      }
      return result.data ?? null;
    } catch (error) {
      warnDiscardedState('ElectronPanelPersistenceAdapter', describeError(error));
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
