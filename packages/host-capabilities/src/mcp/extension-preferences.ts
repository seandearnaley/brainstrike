/**
 * The global MCP registered-extension off switch (BST-1604), kept in the host's
 * own StateStore settings (BST-1930 c5a). Only the host writes it; a desktop
 * client reaches it through `mcp/extensions/*`.
 */
import {
  MCP_EXTENSIONS_ENABLED,
  type McpExtensionEnablement,
  parseMcpExtensionEnablement,
} from '@brainstrike/assistant-contract';

export const MCP_EXTENSION_PREFERENCES_SETTING = 'mcp.extensionPreferences';

/** The slice of the host's StateStore settings this module touches. */
export interface McpExtensionPreferencesStore {
  deleteSetting(key: string): Promise<boolean>;
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
}

export type McpExtensionPreferencesRead =
  | {
      readonly cause: unknown;
      readonly preferences: McpExtensionEnablement;
      readonly state: 'unreadable';
    }
  | { readonly preferences: McpExtensionEnablement; readonly state: 'default' | 'stored' };

function readRecord(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored MCP extension preferences are not a versioned record');
  }
  if (!Object.hasOwn(parsed, 'v1')) {
    throw new Error('Stored MCP extension preferences have no v1 revision');
  }
  return Reflect.get(parsed, 'v1');
}

/**
 * A stored value that cannot be read or parsed is reported as `unreadable` and
 * projects BOTH extensions OFF. The stored value is the only record of a
 * deliberate opt-out, so an unreadable one must never be read as "the user
 * never turned anything off": the host fails closed and Settings says so.
 */
export async function readStoredMcpExtensionPreferences(
  store: McpExtensionPreferencesStore
): Promise<McpExtensionPreferencesRead> {
  let stored: string | undefined;
  try {
    stored = await store.getSetting(MCP_EXTENSION_PREFERENCES_SETTING);
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

/** Validates then persists; a malformed request or failed write throws. */
export async function writeStoredMcpExtensionPreferences(
  store: McpExtensionPreferencesStore,
  preferences: unknown
): Promise<McpExtensionEnablement> {
  const validated = parseMcpExtensionEnablement(preferences);
  await store.setSetting(
    MCP_EXTENSION_PREFERENCES_SETTING,
    JSON.stringify({ v1: { ...validated } })
  );
  return validated;
}

/** Factory reset: drop the stored opt-out so the next read is the default. */
export async function clearStoredMcpExtensionPreferences(
  store: McpExtensionPreferencesStore
): Promise<void> {
  await store.deleteSetting(MCP_EXTENSION_PREFERENCES_SETTING);
}
