import {
  McpExtensionEnablementSchema,
  McpHostControlRequestSchema,
  type McpHostServerSnapshot,
  type McpHostSnapshot,
} from '@brainstrike/assistant-contract';
import {
  parseMcpHostServerSnapshot,
  parseMcpHostSnapshot,
} from '@brainstrike/assistant-contract/mcp-host-status';
import { Schema } from 'effect';
import { opaqueWireSchema } from './opaque-wire-schema.js';

/**
 * The desktop host's MCP settings (BST-1930 c5a): the config file, the global
 * extension dials, and the discovered tools with their saved preferences. The
 * host owns all three; a client reads and changes them only through these
 * methods and hears changes through `mcp/settings/event`. The same stream
 * carries the runtime's server status (c5b), which lifecycle control changes.
 */
const Id = Schema.String.check(Schema.isMinCodePoints(1));
export const McpConfigStatusSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  exists: Schema.Boolean,
  loadedAt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  migrations: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          code: Schema.Literal('mcp_protocol_defaulted_to_legacy'),
          serverIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          serverName: Schema.String,
        })
      )
    )
  ),
  path: Schema.String,
  servers: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          protocol: Schema.Literals(['legacy', 'auto', '2026-07-28']),
          transport: Schema.Literals(['stdio', 'sse', 'streamable-http']),
        })
      )
    )
  ),
});
export type McpConfigStatus = (typeof McpConfigStatusSchema)['Type'];
export const McpConfigTextSchema = Schema.Struct({
  content: Schema.String,
  created: Schema.Boolean,
  error: Schema.optional(Schema.String),
  exists: Schema.Boolean,
  path: Schema.String,
});
export const McpToolMetadataSchema = Schema.Struct({
  description: Schema.optional(Schema.String),
  discoveredAt: Schema.Finite,
  enabled: Schema.Boolean,
  id: Id,
  inputSchema: Schema.optional(Schema.MutableJson),
  serverName: Schema.String,
});
/** Every discovered tool, grouped by its configured server's name. */
export const McpToolsByServerSchema = Schema.Record(
  Schema.String,
  Schema.mutable(Schema.Array(McpToolMetadataSchema))
);
export type McpToolsByServer = (typeof McpToolsByServerSchema)['Type'];
export const McpToolStatsSchema = Schema.Struct({
  disabled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  enabled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  preferencesFault: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(['invalid', 'unreadable']),
      message: Schema.String,
      path: Schema.String,
    })
  ),
  servers: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpToolStats = (typeof McpToolStatsSchema)['Type'];
/** The runtime's server status: a whole revision, as a read or a watch event. */
export const McpHostStatusSchema: Schema.ConstraintDecoder<McpHostSnapshot> = opaqueWireSchema(
  (value): McpHostSnapshot => parseMcpHostSnapshot(value)
);
// Annotated so declarations name the contract's type, not its unexported parts.
const McpHostServerStatusSchema: Schema.ConstraintDecoder<McpHostServerSnapshot> = opaqueWireSchema(
  (value): McpHostServerSnapshot => parseMcpHostServerSnapshot(value)
);
/** What a settings subscriber holds, and each change pushed to it. */
export const McpSettingsSnapshotSchema = Schema.Struct({
  config: McpConfigStatusSchema,
  extensions: McpExtensionEnablementSchema,
  status: McpHostStatusSchema,
  tools: McpToolsByServerSchema,
});
export type McpSettingsSnapshot = (typeof McpSettingsSnapshotSchema)['Type'];
/** Host -> subscribed client: one MCP settings fact changed. */
export const MCP_SETTINGS_EVENT = 'mcp/settings/event';
export const McpSettingsEventSchema = Schema.Union(
  [
    Schema.Struct({ config: McpConfigStatusSchema, type: Schema.Literal('config') }),
    Schema.Struct({ extensions: McpExtensionEnablementSchema, type: Schema.Literal('extensions') }),
    Schema.Struct({ status: McpHostStatusSchema, type: Schema.Literal('status') }),
    Schema.Struct({ tools: McpToolsByServerSchema, type: Schema.Literal('tools') }),
  ],
  { mode: 'oneOf' }
);
export type McpSettingsEvent = (typeof McpSettingsEventSchema)['Type'];
const Applied = Schema.Struct({ applied: Schema.Literal(true) });
const None = Schema.Record(Schema.String, Schema.Never);
export const MCP_SETTINGS_METHOD_SCHEMAS = {
  'mcp/config/path': None,
  /** `null` restores the profile's default path; any other path must be picker-selected. */
  'mcp/config/path/set': Schema.Struct({ path: Schema.NullOr(Schema.String) }),
  'mcp/config/read': None,
  'mcp/config/sample': None,
  'mcp/config/status': None,
  'mcp/config/write': Schema.Struct({ content: Schema.String }),
  'mcp/extensions/read': None,
  'mcp/extensions/set': McpExtensionEnablementSchema,
  /** connect, retry, cancel, disconnect or reauthorize one configured server. */
  'mcp/server/control': McpHostControlRequestSchema,
  'mcp/settings/subscribe': None,
  'mcp/status/read': None,
  'mcp/tools/list': None,
  'mcp/tools/reload': None,
  'mcp/tools/reset': None,
  'mcp/tools/server/set': Schema.Struct({ enabled: Schema.Boolean, serverName: Id }),
  'mcp/tools/set': Schema.Struct({
    enabled: Schema.Boolean,
    toolIds: Schema.mutable(Schema.Array(Id)),
  }),
  'mcp/tools/stats': None,
} as const;
export const MCP_SETTINGS_RESULT_SCHEMAS = {
  'mcp/config/path': Schema.Struct({ path: Schema.String }),
  'mcp/config/path/set': Schema.Struct({ path: Schema.String, success: Schema.Literal(true) }),
  'mcp/config/read': McpConfigTextSchema,
  'mcp/config/sample': Schema.Struct({
    error: Schema.optional(Schema.String),
    path: Schema.String,
    success: Schema.Boolean,
  }),
  'mcp/config/status': McpConfigStatusSchema,
  'mcp/config/write': Schema.Union(
    [
      Schema.Struct({ path: Schema.String, success: Schema.Literal(true) }),
      Schema.Struct({ error: Schema.String, path: Schema.String, success: Schema.Literal(false) }),
    ],
    { mode: 'oneOf' }
  ),
  'mcp/extensions/read': McpExtensionEnablementSchema,
  'mcp/extensions/set': McpExtensionEnablementSchema,
  'mcp/server/control': McpHostServerStatusSchema,
  'mcp/settings/subscribe': McpSettingsSnapshotSchema,
  'mcp/status/read': McpHostStatusSchema,
  'mcp/tools/list': McpToolsByServerSchema,
  'mcp/tools/reload': Applied,
  'mcp/tools/reset': Applied,
  'mcp/tools/server/set': Applied,
  'mcp/tools/set': Applied,
  'mcp/tools/stats': McpToolStatsSchema,
} as const;
