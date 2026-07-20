import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronPanelPersistenceAdapter,
  LocalStoragePanelPersistenceAdapter,
  type PanelPersistenceAdapter,
} from '../hooks/panel-persistence-adapters';
import type { LayoutElectronAPI, LayoutLoadResult } from '../types/electron';
import type { PanelPersistenceState } from '../types/panel';

describe('panel-persistence-adapters', () => {
  const testState: PanelPersistenceState = {
    showConsole: true,
    showLeftPanel: true,
    showRightPanel: true,
    sizes: [25, 50, 25],
  };

  const capturedWarnings: LogRecord[] = [];
  let removeLogListener: () => void;

  beforeEach(() => {
    capturedWarnings.length = 0;
    removeLogListener = addLogListener((record) => {
      if (record.scope === 'PanelPersistenceAdapters' && record.level === LogLevel.WARN) {
        capturedWarnings.push(record);
      }
    });
  });

  afterEach(() => {
    removeLogListener();
    vi.unstubAllGlobals();
  });

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

    it('hydrates defaults but surfaces a warning when the payload is corrupted', async () => {
      localStorage.setItem('panelLayout.v1', 'invalid json');
      const adapter = new LocalStoragePanelPersistenceAdapter();

      const result = await adapter.load();

      // Return-null-hydrate-defaults behavior is preserved...
      expect(result).toBeNull();
      // ...but the discarded payload is reported, not silently eaten.
      expect(capturedWarnings).toHaveLength(1);
      expect(capturedWarnings[0]?.args[0]).toContain('panel state');
      expect(capturedWarnings[0]?.args[1]).toMatchObject({
        adapter: 'LocalStoragePanelPersistenceAdapter',
      });
      expect(JSON.stringify(capturedWarnings[0]?.args[1])).toMatch(/JSON|Unexpected|token/i);
    });

    it('surfaces a warning when localStorage itself throws', async () => {
      // happy-dom's localStorage is a Proxy: prototype spies silently never
      // fire (false-green), so failure injection goes through vi.stubGlobal
      // (BST-579 pattern).
      vi.stubGlobal('localStorage', {
        clear: () => undefined,
        getItem: () => {
          throw new Error('localStorage getItem error');
        },
        key: () => null,
        length: 0,
        removeItem: () => undefined,
        setItem: () => undefined,
      });
      const adapter = new LocalStoragePanelPersistenceAdapter();

      const result = await adapter.load();

      expect(result).toBeNull();
      expect(capturedWarnings).toHaveLength(1);
      expect(JSON.stringify(capturedWarnings[0]?.args[1])).toContain('localStorage getItem error');
    });

    it('does not warn on a clean load', async () => {
      const adapter = new LocalStoragePanelPersistenceAdapter();
      await adapter.save(testState);

      await expect(adapter.load()).resolves.toEqual(testState);
      expect(capturedWarnings).toHaveLength(0);
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

    it('surfaces a warning when the layout IPC rejects', async () => {
      vi.stubGlobal('electronAPI', {
        loadLayout: () => Promise.reject(new Error('layout channel unavailable')),
        saveLayout: () => Promise.resolve({ success: true }),
      } satisfies LayoutElectronAPI);
      const adapter = new ElectronPanelPersistenceAdapter();

      const result = await adapter.load();

      expect(result).toBeNull();
      expect(capturedWarnings).toHaveLength(1);
      expect(capturedWarnings[0]?.args[0]).toContain('panel state');
      expect(capturedWarnings[0]?.args[1]).toMatchObject({
        adapter: 'ElectronPanelPersistenceAdapter',
      });
      expect(JSON.stringify(capturedWarnings[0]?.args[1])).toContain('layout channel unavailable');
    });

    it('surfaces the message when the layout IPC reports failure', async () => {
      const failure: LayoutLoadResult = { message: 'layout file is corrupted', success: false };
      vi.stubGlobal('electronAPI', {
        loadLayout: () => Promise.resolve(failure),
        saveLayout: () => Promise.resolve({ success: true }),
      } satisfies LayoutElectronAPI);
      const adapter = new ElectronPanelPersistenceAdapter();

      const result = await adapter.load();

      expect(result).toBeNull();
      expect(capturedWarnings).toHaveLength(1);
      expect(JSON.stringify(capturedWarnings[0]?.args[1])).toContain('layout file is corrupted');
    });

    it('does not warn on a clean load', async () => {
      vi.stubGlobal('electronAPI', {
        loadLayout: () => Promise.resolve({ data: testState, success: true }),
        saveLayout: () => Promise.resolve({ success: true }),
      } satisfies LayoutElectronAPI);
      const adapter = new ElectronPanelPersistenceAdapter();

      await expect(adapter.load()).resolves.toEqual(testState);
      expect(capturedWarnings).toHaveLength(0);
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
