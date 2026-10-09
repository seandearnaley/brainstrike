import { McpExtensionEnablementSchema } from '@brainstrike/assistant-contract';
import { z } from 'zod';

/**
 * The desktop host's MCP settings (BST-1930 c5a): the config file, the global
 * extension dials, and the discovered tools with their saved preferences. The
 * host owns all three; a client reads and changes them only through these
 * methods and hears changes through `mcp/settings/event`.
 */
const Id = z.string().min(1);

export const McpConfigStatusSchema = z.strictObject({
  error: z.string().optional(),
  exists: z.boolean(),
  loadedAt: z.number().int().nonnegative().optional(),
  migrations: z
    .array(
      z.strictObject({
        code: z.literal('mcp_protocol_defaulted_to_legacy'),
        serverIndex: z.number().int().nonnegative(),
        serverName: z.string(),
      })
    )
    .optional(),
  path: z.string(),
  servers: z
    .array(
      z.strictObject({
        name: z.string(),
        protocol: z.enum(['legacy', 'auto', '2026-07-28']),
        transport: z.enum(['stdio', 'sse', 'streamable-http']),
      })
    )
    .optional(),
});
export type McpConfigStatus = z.infer<typeof McpConfigStatusSchema>;

export const McpConfigTextSchema = z.strictObject({
  content: z.string(),
  created: z.boolean(),
  error: z.string().optional(),
  exists: z.boolean(),
  path: z.string(),
});

export const McpToolMetadataSchema = z.strictObject({
  description: z.string().optional(),
  discoveredAt: z.number(),
  enabled: z.boolean(),
  id: Id,
  inputSchema: z.json().optional(),
  serverName: z.string(),
});
/** Every discovered tool, grouped by its configured server's name. */
export const McpToolsByServerSchema = z.record(z.string(), z.array(McpToolMetadataSchema));
export type McpToolsByServer = z.infer<typeof McpToolsByServerSchema>;

export const McpToolStatsSchema = z.strictObject({
  disabled: z.number().int().nonnegative(),
  enabled: z.number().int().nonnegative(),
  preferencesFault: z
    .strictObject({
      kind: z.enum(['invalid', 'unreadable']),
      message: z.string(),
      path: z.string(),
    })
    .optional(),
  servers: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type McpToolStats = z.infer<typeof McpToolStatsSchema>;

/** What a settings subscriber holds, and each change pushed to it. */
export const McpSettingsSnapshotSchema = z.strictObject({
  config: McpConfigStatusSchema,
  extensions: McpExtensionEnablementSchema,
  tools: McpToolsByServerSchema,
});
export type McpSettingsSnapshot = z.infer<typeof McpSettingsSnapshotSchema>;

/** Host -> subscribed client: one MCP settings fact changed. */
export const MCP_SETTINGS_EVENT = 'mcp/settings/event';
export const McpSettingsEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ config: McpConfigStatusSchema, type: z.literal('config') }),
  z.strictObject({ extensions: McpExtensionEnablementSchema, type: z.literal('extensions') }),
  z.strictObject({ tools: McpToolsByServerSchema, type: z.literal('tools') }),
]);
export type McpSettingsEvent = z.infer<typeof McpSettingsEventSchema>;

const Applied = z.strictObject({ applied: z.literal(true) });
const None = z.strictObject({});

export const MCP_SETTINGS_METHOD_SCHEMAS = {
  'mcp/config/path': None,
  /** `null` restores the profile's default path; any other path must be picker-selected. */
  'mcp/config/path/set': z.strictObject({ path: z.string().nullable() }),
  'mcp/config/read': None,
  'mcp/config/sample': None,
  'mcp/config/status': None,
  'mcp/config/write': z.strictObject({ content: z.string() }),
  'mcp/extensions/read': None,
  'mcp/extensions/set': McpExtensionEnablementSchema,
  'mcp/settings/subscribe': None,
  'mcp/tools/list': None,
  'mcp/tools/reload': None,
  'mcp/tools/reset': None,
  'mcp/tools/server/set': z.strictObject({ enabled: z.boolean(), serverName: Id }),
  'mcp/tools/set': z.strictObject({ enabled: z.boolean(), toolIds: z.array(Id) }),
  'mcp/tools/stats': None,
} as const;

export const MCP_SETTINGS_RESULT_SCHEMAS = {
  'mcp/config/path': z.strictObject({ path: z.string() }),
  'mcp/config/path/set': z.strictObject({ path: z.string(), success: z.literal(true) }),
  'mcp/config/read': McpConfigTextSchema,
  'mcp/config/sample': z.strictObject({
    error: z.string().optional(),
    path: z.string(),
    success: z.boolean(),
  }),
  'mcp/config/status': McpConfigStatusSchema,
  'mcp/config/write': z.discriminatedUnion('success', [
    z.strictObject({ path: z.string(), success: z.literal(true) }),
    z.strictObject({ error: z.string(), path: z.string(), success: z.literal(false) }),
  ]),
  'mcp/extensions/read': McpExtensionEnablementSchema,
  'mcp/extensions/set': McpExtensionEnablementSchema,
  'mcp/settings/subscribe': McpSettingsSnapshotSchema,
  'mcp/tools/list': McpToolsByServerSchema,
  'mcp/tools/reload': Applied,
  'mcp/tools/reset': Applied,
  'mcp/tools/server/set': Applied,
  'mcp/tools/set': Applied,
  'mcp/tools/stats': McpToolStatsSchema,
} as const;
