import { beforeEach, describe, expect, it, vi } from 'vitest';

const LEGACY_STORE_NAME = 'right-panel.v1' as const;
const STORE_NAME = 'tools-panel.v1' as const;
const legacyState = JSON.stringify({ state: { activeTab: 'vectors' }, version: 1 });

function setLocalStorageItem(key: string, value: string): void {
  localStorage.setItem(key, value);
}

describe('tools-panel-store migration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('migrates legacy storage to the new key when missing', async () => {
    setLocalStorageItem(LEGACY_STORE_NAME, legacyState);

    const { useToolsPanelStore } = await import('./tools-panel-store');

    expect(useToolsPanelStore.getState().activeTab).toBeDefined();
    expect(localStorage.getItem(STORE_NAME)).toBe(legacyState);
    expect(localStorage.getItem(LEGACY_STORE_NAME)).toBeNull();
  });

  it('does not migrate when legacy storage is missing', async () => {
    const { useToolsPanelStore } = await import('./tools-panel-store');

    expect(useToolsPanelStore.getState().activeTab).toBeDefined();
    expect(localStorage.getItem(STORE_NAME)).toBeNull();
  });

  it('preserves existing tools panel storage without overwriting', async () => {
    const existingState = JSON.stringify({ state: { activeTab: 'assistant' }, version: 1 });
    setLocalStorageItem(LEGACY_STORE_NAME, legacyState);
    setLocalStorageItem(STORE_NAME, existingState);

    const { useToolsPanelStore } = await import('./tools-panel-store');

    expect(useToolsPanelStore.getState().activeTab).toBeDefined();
    expect(localStorage.getItem(STORE_NAME)).toBe(existingState);
    expect(localStorage.getItem(LEGACY_STORE_NAME)).toBe(legacyState);
  });

  it('reset helper clears storage and resets state', async () => {
    const { __resetToolsPanelStoreForTests, useToolsPanelStore } = await import(
      './tools-panel-store'
    );

    useToolsPanelStore.setState({ activeTab: 'vectors' });
    setLocalStorageItem(STORE_NAME, legacyState);
    setLocalStorageItem(LEGACY_STORE_NAME, legacyState);

    __resetToolsPanelStoreForTests();

    expect(useToolsPanelStore.getState().activeTab).toBe('assistant');
    expect(localStorage.getItem(LEGACY_STORE_NAME)).toBeNull();
  });
});
