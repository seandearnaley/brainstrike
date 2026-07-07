import { beforeEach, describe, expect, it } from 'vitest';
import {
  ElectronPanelPersistenceAdapter,
  LocalStoragePanelPersistenceAdapter,
  type PanelPersistenceAdapter,
} from '../hooks/panel-persistence-adapters';
import type { PanelPersistenceState } from '../types/panel';

describe('panel-persistence-adapters', () => {
  const testState: PanelPersistenceState = {
    showConsole: true,
    showLeftPanel: true,
    showRightPanel: true,
    sizes: [25, 50, 25],
  };

  describe('LocalStoragePanelPersistenceAdapter', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('creates an adapter instance', () => {
      const adapter = new LocalStoragePanelPersistenceAdapter();
      expect(adapter).toBeDefined();
      expect(adapter.load).toBeDefined();
      expect(adapter.save).toBeDefined();
    });

    it('returns null when no data is stored', async () => {
      const adapter = new LocalStoragePanelPersistenceAdapter();
      const result = await adapter.load();
      expect(result).toBeNull();
    });

    it('saves and loads state correctly', async () => {
      const adapter = new LocalStoragePanelPersistenceAdapter();
      await adapter.save(testState);
      const loaded = await adapter.load();
      expect(loaded).toEqual(testState);
    });

    it('handles invalid JSON gracefully', async () => {
      localStorage.setItem('panelLayout.v1', 'invalid json');
      const adapter = new LocalStoragePanelPersistenceAdapter();
      const result = await adapter.load();
      expect(result).toBeNull();
    });

    it('has a flush method', async () => {
      const adapter = new LocalStoragePanelPersistenceAdapter();
      expect(adapter.flush).toBeDefined();
      await expect(adapter.flush?.()).resolves.toBeUndefined();
    });

    it('implements PanelPersistenceAdapter interface', () => {
      const adapter: PanelPersistenceAdapter = new LocalStoragePanelPersistenceAdapter();
      expect(typeof adapter.load).toBe('function');
      expect(typeof adapter.save).toBe('function');
    });
  });

  describe('ElectronPanelPersistenceAdapter', () => {
    it('creates an adapter instance', () => {
      const adapter = new ElectronPanelPersistenceAdapter();
      expect(adapter).toBeDefined();
      expect(adapter.load).toBeDefined();
      expect(adapter.save).toBeDefined();
    });

    it('returns null when not in electron environment', async () => {
      const adapter = new ElectronPanelPersistenceAdapter();
      const result = await adapter.load();
      expect(result).toBeNull();
    });

    it('does not throw when saving without electron API', async () => {
      const adapter = new ElectronPanelPersistenceAdapter();
      await expect(adapter.save(testState)).resolves.toBeUndefined();
    });

    it('has a flush method', async () => {
      const adapter = new ElectronPanelPersistenceAdapter();
      expect(adapter.flush).toBeDefined();
      await expect(adapter.flush?.()).resolves.toBeUndefined();
    });

    it('implements PanelPersistenceAdapter interface', () => {
      const adapter: PanelPersistenceAdapter = new ElectronPanelPersistenceAdapter();
      expect(typeof adapter.load).toBe('function');
      expect(typeof adapter.save).toBe('function');
    });
  });
});
