/**
 * Registered MCP client extension enablement (BST-1604).
 *
 * Both registered extensions ship ON. This module carries the two dials that
 * can turn one off without a new build: a per-server override in the MCP
 * configuration document and a global preference owned by the desktop main
 * process. The effective state is `global AND per-server`, decided once per
 * connection generation — never mutated on a live registry.
 */
import { z } from 'zod';

/** Config-document keys for the extensions the desktop host registers. */
export const MCP_EXTENSION_KEYS = ['apps', 'tasks'] as const;
export type McpExtensionKey = (typeof MCP_EXTENSION_KEYS)[number];

/** Canonical extension identifier advertised for each key. */
export const MCP_EXTENSION_ID_BY_KEY = Object.freeze({
  apps: 'io.modelcontextprotocol/ui',
  tasks: 'io.modelcontextprotocol/tasks',
}) satisfies Readonly<Record<McpExtensionKey, string>>;

/** Human-facing labels for the settings switch and per-server diagnostics. */
export const MCP_EXTENSION_LABEL_BY_KEY = Object.freeze({
  apps: 'MCP Apps',
  tasks: 'MCP Tasks',
}) satisfies Readonly<Record<McpExtensionKey, string>>;

export type McpExtensionEnablement = { readonly [Key in McpExtensionKey]: boolean };

/** The default every dial starts from: every registered extension advertised. */
export const MCP_EXTENSIONS_ENABLED: McpExtensionEnablement = Object.freeze({
  apps: true,
  tasks: true,
});

/**
 * Input is a partial record (an omitted key means "enabled"); output is always
 * both booleans. A present-but-malformed value throws rather than degrading to
 * the default, so a corrupt preference file is visible instead of silently
 * re-enabling an extension the user turned off.
 */
export const McpExtensionEnablementSchema = z.strictObject({
  apps: z.boolean().default(true),
  tasks: z.boolean().default(true),
});

export function parseMcpExtensionEnablement(value: unknown): McpExtensionEnablement {
  return Object.freeze(McpExtensionEnablementSchema.parse(value));
}

/**
 * Effective enablement for one server: the global preference AND the server's
 * own override. Either dial alone is enough to turn an extension off.
 */
export function resolveMcpExtensionEnablement(
  overrides: Partial<McpExtensionEnablement> | undefined,
  preferences: McpExtensionEnablement = MCP_EXTENSIONS_ENABLED
): McpExtensionEnablement {
  return Object.freeze({
    apps: preferences.apps && (overrides?.apps ?? true),
    tasks: preferences.tasks && (overrides?.tasks ?? true),
  });
}

/** True when no registered extension survives the two dials. */
export function hasNoEnabledMcpExtension(enablement: McpExtensionEnablement): boolean {
  return MCP_EXTENSION_KEYS.every((key) => !enablement[key]);
}

/** The extension ids an enablement projects, in support-matrix order. */
export function enabledMcpExtensionIds(enablement: McpExtensionEnablement): readonly string[] {
  return MCP_EXTENSION_KEYS.filter((key) => enablement[key]).map(
    (key) => MCP_EXTENSION_ID_BY_KEY[key]
  );
}
