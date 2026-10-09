/**
 * Global MCP registered-extension preference storage (BST-1604) in the host's
 * StateStore settings: the shipped default, the versioned record, and the
 * fail-closed unreadable case.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clearStoredMcpExtensionPreferences,
  MCP_EXTENSION_PREFERENCES_SETTING,
  type McpExtensionPreferencesStore,
  readStoredMcpExtensionPreferences,
  writeStoredMcpExtensionPreferences,
} from '../src/mcp/extension-preferences.js';

function createStore(initial?: unknown) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(MCP_EXTENSION_PREFERENCES_SETTING, JSON.stringify(initial));
  }
  const store: McpExtensionPreferencesStore = {
    deleteSetting: vi.fn(async (key: string) => values.delete(key)),
    getSetting: vi.fn(async (key: string) => values.get(key)),
    setSetting: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return { store, values };
}

describe('readStoredMcpExtensionPreferences', () => {
  it('returns the shipped default when nothing is stored', async () => {
    const { store } = createStore();
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toEqual({
      preferences: { apps: true, tasks: true },
      state: 'default',
    });
  });

  it('reads a stored v1 opt-out', async () => {
    const { store } = createStore({ v1: { apps: false, tasks: true } });
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toMatchObject({
      preferences: { apps: false, tasks: true },
      state: 'stored',
    });
  });

  it.each([
    ['not a record', 42],
    ['no v1 revision', { v2: { apps: true, tasks: true } }],
    ['a malformed v1 revision', { v1: { apps: 'yes' } }],
    ['an unknown key', { v1: { apps: true, ui: true } }],
  ])('fails closed on %s rather than re-enabling an opt-out', async (_label, stored) => {
    const { store } = createStore(stored);
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toMatchObject({
      preferences: { apps: false, tasks: false },
      state: 'unreadable',
    });
  });

  it('fails closed on a stored value that is not JSON', async () => {
    const { store, values } = createStore();
    values.set(MCP_EXTENSION_PREFERENCES_SETTING, '{not json');
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toMatchObject({
      preferences: { apps: false, tasks: false },
      state: 'unreadable',
    });
  });

  it('fails closed when the store itself rejects', async () => {
    const { store } = createStore();
    vi.mocked(store.getSetting).mockRejectedValueOnce(new Error('state store unavailable'));
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toMatchObject({
      preferences: { apps: false, tasks: false },
      state: 'unreadable',
    });
  });
});

describe('writeStoredMcpExtensionPreferences', () => {
  it('normalizes an omitted key to enabled and persists a versioned record', async () => {
    const { store, values } = createStore();
    await expect(writeStoredMcpExtensionPreferences(store, { tasks: false })).resolves.toEqual({
      apps: true,
      tasks: false,
    });
    expect(JSON.parse(values.get(MCP_EXTENSION_PREFERENCES_SETTING) ?? 'null')).toEqual({
      v1: { apps: true, tasks: false },
    });
  });

  it('rejects a malformed request without touching the store', async () => {
    const { store } = createStore();
    await expect(writeStoredMcpExtensionPreferences(store, { apps: 1 })).rejects.toThrow();
    expect(store.setSetting).not.toHaveBeenCalled();
  });

  it('rejects when the store write fails', async () => {
    const { store } = createStore();
    vi.mocked(store.setSetting).mockRejectedValueOnce(new Error('state store closed'));
    await expect(writeStoredMcpExtensionPreferences(store, { apps: false })).rejects.toThrow(
      'state store closed'
    );
  });
});

describe('clearStoredMcpExtensionPreferences', () => {
  it('drops the stored opt-out so the next read is the shipped default', async () => {
    const { store } = createStore({ v1: { apps: false, tasks: false } });
    await clearStoredMcpExtensionPreferences(store);
    await expect(readStoredMcpExtensionPreferences(store)).resolves.toEqual({
      preferences: { apps: true, tasks: true },
      state: 'default',
    });
  });
});
