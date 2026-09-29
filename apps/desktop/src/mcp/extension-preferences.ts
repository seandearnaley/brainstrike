/**
 * Global MCP registered-extension off switch, main-process side (BST-1604).
 *
 * The preference lives in the same `brainstrike-settings` electron-store the
 * rest of the desktop settings use, so `settings:clearAll` (factory reset)
 * already clears it and the next read returns the shipped default. Only main
 * writes it; the renderer reaches it through the `mcp:extensions:*` channels.
 */
import {
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  parseMcpExtensionEnablement,
} from '@brainstrike/assistant-contract';

export const MCP_EXTENSION_PREFERENCES_STORE_KEY = 'mcpExtensionPreferences';

/** The slice of the settings store this module touches. */
export interface McpExtensionPreferencesStore {
  delete(key: string): void;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Returns `null` before `app.ready`, exactly like `getSettingsStore`. */
export type McpExtensionPreferencesStoreAccess = () => McpExtensionPreferencesStore | null;

export type McpExtensionPreferencesRead =
  | {
      readonly cause: unknown;
      readonly preferences: McpExtensionEnablement;
      readonly state: 'unreadable';
    }
  | { readonly preferences: McpExtensionEnablement; readonly state: 'default' | 'stored' };

function readRecord(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored MCP extension preferences are not a versioned record');
  }
  if (!Object.hasOwn(value, 'v1')) {
    throw new Error('Stored MCP extension preferences have no v1 revision');
  }
  return Reflect.get(value, 'v1');
}

/**
 * A stored value that cannot be parsed is reported as `unreadable` and projects
 * BOTH extensions OFF. The stored value is the only record of a deliberate
 * opt-out, so an unreadable one must never be read as "the user never turned
 * anything off" — the host fails closed and the settings surface says so.
 */
export function readStoredMcpExtensionPreferences(
  access: McpExtensionPreferencesStoreAccess
): McpExtensionPreferencesRead {
  let stored: unknown;
  try {
    const store = access();
    if (!store) {
      return { preferences: MCP_EXTENSIONS_ENABLED, state: 'default' };
    }
    stored = store.get(MCP_EXTENSION_PREFERENCES_STORE_KEY);
  } catch (cause) {
    return { cause, preferences: { apps: false, tasks: false }, state: 'unreadable' };
  }
  if (stored === undefined) {
    return { preferences: MCP_EXTENSIONS_ENABLED, state: 'default' };
  }
  try {
    return { preferences: parseMcpExtensionEnablement(readRecord(stored)), state: 'stored' };
  } catch (cause) {
    return { cause, preferences: { apps: false, tasks: false }, state: 'unreadable' };
  }
}

/** Validates then persists; a malformed request or missing store throws. */
export function writeStoredMcpExtensionPreferences(
  access: McpExtensionPreferencesStoreAccess,
  preferences: unknown
): McpExtensionEnablement {
  const validated = parseMcpExtensionEnablement(preferences);
  const store = access();
  if (!store) {
    throw new Error('Desktop settings store is unavailable for MCP extension preferences');
  }
  store.set(MCP_EXTENSION_PREFERENCES_STORE_KEY, { v1: { ...validated } });
  return validated;
}

/** Factory reset: drop the stored opt-out so the next read is the default. */
export function clearStoredMcpExtensionPreferences(
  access: McpExtensionPreferencesStoreAccess
): void {
  access()?.delete(MCP_EXTENSION_PREFERENCES_STORE_KEY);
}
