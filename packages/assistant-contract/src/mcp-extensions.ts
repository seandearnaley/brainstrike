import { Effect, Schema } from 'effect';
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
export type McpExtensionEnablement = {
  readonly [Key in McpExtensionKey]: boolean;
};
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
export const McpExtensionEnablementSchema = Schema.Struct({
  apps: Schema.Boolean.annotate({ default: true }).pipe(
    Schema.withDecodingDefault(Effect.succeed(true))
  ),
  tasks: Schema.Boolean.annotate({ default: true }).pipe(
    Schema.withDecodingDefault(Effect.succeed(true))
  ),
});
export function parseMcpExtensionEnablement(value: unknown): McpExtensionEnablement {
  return Object.freeze(
    Schema.decodeUnknownSync(McpExtensionEnablementSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(value)
  );
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
