/**
 * Global MCP registered-extension preference storage (BST-1604): the shipped
 * default, the versioned record, and the fail-closed unreadable case.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  clearStoredMcpExtensionPreferences,
  MCP_EXTENSION_PREFERENCES_STORE_KEY,
  type McpExtensionPreferencesStore,
  readStoredMcpExtensionPreferences,
  writeStoredMcpExtensionPreferences,
} from '../../mcp/extension-preferences';

function createStore(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) {
    values.set(MCP_EXTENSION_PREFERENCES_STORE_KEY, initial);
  }
  const store: McpExtensionPreferencesStore = {
    delete: vi.fn((key: string) => {
      values.delete(key);
    }),
    get: vi.fn((key: string) => values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
  return { store, values };
}

describe('readStoredMcpExtensionPreferences', () => {
  it('returns the shipped default when nothing is stored', () => {
    const { store } = createStore();
    expect(readStoredMcpExtensionPreferences(() => store)).toEqual({
      preferences: { apps: true, tasks: true },
      state: 'default',
    });
  });

  it('returns the shipped default before the settings store exists', () => {
    expect(readStoredMcpExtensionPreferences(() => null)).toEqual({
      preferences: { apps: true, tasks: true },
      state: 'default',
    });
  });

  it('reads a stored v1 opt-out', () => {
    const { store } = createStore({ v1: { apps: false, tasks: true } });
    expect(readStoredMcpExtensionPreferences(() => store)).toMatchObject({
      preferences: { apps: false, tasks: true },
      state: 'stored',
    });
  });

  it.each([
    ['not a record', 42],
    ['no v1 revision', { v2: { apps: true, tasks: true } }],
    ['a malformed v1 revision', { v1: { apps: 'yes' } }],
    ['an unknown key', { v1: { apps: true, ui: true } }],
  ])('fails closed on %s rather than re-enabling an opt-out', (_label, stored) => {
    const { store } = createStore(stored);
    const read = readStoredMcpExtensionPreferences(() => store);
    expect(read).toMatchObject({
      preferences: { apps: false, tasks: false },
      state: 'unreadable',
    });
  });

  it('fails closed when the store itself throws', () => {
    const read = readStoredMcpExtensionPreferences(() => {
      throw new Error('settings store unavailable');
    });
    expect(read).toMatchObject({ preferences: { apps: false, tasks: false }, state: 'unreadable' });
  });
});

describe('writeStoredMcpExtensionPreferences', () => {
  it('normalizes an omitted key to enabled and persists a versioned record', () => {
    const { store, values } = createStore();
    expect(writeStoredMcpExtensionPreferences(() => store, { tasks: false })).toEqual({
      apps: true,
      tasks: false,
    });
    expect(values.get(MCP_EXTENSION_PREFERENCES_STORE_KEY)).toEqual({
      v1: { apps: true, tasks: false },
    });
  });

  it('throws on a malformed request without touching the store', () => {
    const { store } = createStore();
    expect(() => writeStoredMcpExtensionPreferences(() => store, { apps: 1 })).toThrow();
    expect(store.set).not.toHaveBeenCalled();
  });

  it('throws when no settings store is available', () => {
    expect(() => writeStoredMcpExtensionPreferences(() => null, { apps: false })).toThrow(
      /settings store is unavailable/iu
    );
  });
});

describe('clearStoredMcpExtensionPreferences', () => {
  it('drops the stored opt-out so the next read is the shipped default', () => {
    const { store } = createStore({ v1: { apps: false, tasks: false } });
    clearStoredMcpExtensionPreferences(() => store);
    expect(readStoredMcpExtensionPreferences(() => store)).toEqual({
      preferences: { apps: true, tasks: true },
      state: 'default',
    });
  });

  it('is a no-op before the settings store exists', () => {
    expect(() => clearStoredMcpExtensionPreferences(() => null)).not.toThrow();
  });
});
