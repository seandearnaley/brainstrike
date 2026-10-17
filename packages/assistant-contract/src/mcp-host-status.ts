import { Schema } from 'effect';
import { McpExtensionEnablementSchema } from './mcp-extensions.js';
import type {
  McpHostCatalogErrors,
  McpHostJsonValue,
  McpHostOperationResult,
  McpHostServerSnapshot,
  McpHostSnapshot,
} from './mcp-host.js';
import {
  ConfiguredMcpServerIdSchema,
  MCP_HOST_CATALOG_SECTIONS,
  MCP_HOST_DIAGNOSTIC_MAX_ENTRIES,
  McpHostErrorSchema,
  McpResourceUriSchema,
} from './mcp-host.js';

/**
 * The MCP host's server status at a process boundary (BST-1930 c5b), browser
 * safe: it imports no MCP SDK value, so the agent host's protocol and the
 * renderers that load it never bundle the SDK. A catalog's list results are
 * held as strict JSON here; the host validated each against the SDK's schema
 * when it listed it (`./mcp-host-runtime`, node-only, BST-1512).
 */
const McpHostJsonValueSchema: Schema.ConstraintDecoder<McpHostJsonValue> = Schema.MutableJson;
export const McpHostServerFeaturesSchema = Schema.Struct({
  completion: Schema.Boolean,
  promptListChanged: Schema.Boolean,
  prompts: Schema.Boolean,
  resourceListChanged: Schema.Boolean,
  resourceSubscriptions: Schema.Boolean,
  resources: Schema.Boolean,
  toolListChanged: Schema.Boolean,
  tools: Schema.Boolean,
});
const McpHostSubscriptionFilterSchema = Schema.Struct({
  promptsListChanged: Schema.optional(Schema.Boolean),
  resourceSubscriptions: Schema.optional(Schema.mutable(Schema.Array(McpResourceUriSchema))),
  resourcesListChanged: Schema.optional(Schema.Boolean),
  toolsListChanged: Schema.optional(Schema.Boolean),
});
export const McpHostSubscriptionStatusSchema = Schema.Struct({
  honoredFilter: Schema.optional(McpHostSubscriptionFilterSchema),
  mode: Schema.Literals(['legacy-unsolicited', 'modern-listen', 'none']),
  state: Schema.Literals(['closed', 'listening', 'retrying', 'unsupported']),
});
export const McpHostCatalogErrorsSchema: Schema.ConstraintDecoder<McpHostCatalogErrors> =
  Schema.Record(Schema.Literals(MCP_HOST_CATALOG_SECTIONS), Schema.optionalKey(McpHostErrorSchema));
export const McpNegotiatedStatusSchema = Schema.Struct({
  advertisedCapabilityIds: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  era: Schema.Literals(['legacy', 'modern']),
  revision: Schema.String,
  serverIdentity: Schema.optional(
    Schema.Struct({
      description: Schema.optional(Schema.String),
      name: Schema.String,
      title: Schema.optional(Schema.String),
      version: Schema.String,
      websiteUrl: Schema.optional(Schema.String),
    })
  ),
});
const JSON_ERROR = 'MCP host operation result must contain only strict JSON data';
function rejectNonJson(path: string): never {
  throw new TypeError(`${JSON_ERROR} at ${path}`);
}
function readJsonProperty(owner: object, key: string | symbol, path: string): [unknown, string] {
  if (typeof key !== 'string') {
    rejectNonJson(path);
  }
  const childPath = `${path}[${JSON.stringify(key)}]`;
  if (key === '__proto__') {
    rejectNonJson(childPath);
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!(descriptor?.enumerable && 'value' in descriptor)) {
    rejectNonJson(childPath);
  }
  return [descriptor.value, childPath];
}
export function assertMcpHostStrictJson(
  value: unknown,
  path = '$',
  active = new Set<object>(),
  done = new WeakSet<object>()
): asserts value is McpHostJsonValue {
  if (value === null || typeof value !== 'object') {
    if (
      !(
        Schema.decodeUnknownResult(McpHostJsonValueSchema, {
          errors: 'all',
          onExcessProperty: 'error',
        })(value)._tag === 'Success'
      )
    ) {
      rejectNonJson(path);
    }
    return;
  }
  if (done.has(value)) {
    return;
  }
  if (active.has(value)) {
    rejectNonJson(path);
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    rejectNonJson(path);
  }
  active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) {
      rejectNonJson(path);
    }
    for (const key of keys) {
      if (array && key === 'length') {
        continue;
      }
      const [child, childPath] = readJsonProperty(value, key, path);
      assertMcpHostStrictJson(child, childPath, active, done);
    }
  } finally {
    active.delete(value);
  }
  done.add(value);
}
/** A catalog as it crosses: its list results stay strict JSON, as the host validated them. */
const McpHostCatalogWireSchema = Schema.Struct({
  errors: McpHostCatalogErrorsSchema,
  features: McpHostServerFeaturesSchema,
  prompts: Schema.optional(McpHostJsonValueSchema),
  resources: Schema.optional(McpHostJsonValueSchema),
  resourceTemplates: Schema.optional(McpHostJsonValueSchema),
  subscription: McpHostSubscriptionStatusSchema,
  tools: Schema.optional(McpHostJsonValueSchema),
});
const McpHostAuthSnapshotSchema = Schema.Union(
  [
    Schema.Struct({ type: Schema.Literal('none') }),
    Schema.Struct({
      credentialState: Schema.Literals(['malformed', 'missing', 'stored', 'unreadable']),
      type: Schema.Literal('bearer'),
    }),
    Schema.Struct({
      authorizationServer: Schema.optional(Schema.String),
      credentialState: Schema.Literals(['missing', 'stored', 'unreadable']),
      grantedScopes: Schema.mutable(Schema.Array(Schema.String)),
      lastSuccessfulConnectionAt: Schema.optional(Schema.Finite),
      requestedScopes: Schema.mutable(Schema.Array(Schema.String)),
      resourceUrl: Schema.String,
      type: Schema.Literal('oauth-user'),
    }),
  ],
  { mode: 'oneOf' }
);
const McpHostServerSnapshotFields = {
  auth: Schema.optional(McpHostAuthSnapshotSchema),
  configuredProtocol: Schema.Literals(['2026-07-28', 'auto', 'legacy']),
  configuredServerId: ConfiguredMcpServerIdSchema,
  diagnostics: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          message: Schema.String,
          stream: Schema.Literal('stderr'),
          truncated: Schema.Boolean,
        })
      )
    ).check(Schema.isMaxLength(MCP_HOST_DIAGNOSTIC_MAX_ENTRIES))
  ),
  enabledTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  extensions: Schema.optional(McpExtensionEnablementSchema),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  transport: Schema.Literals(['sse', 'stdio', 'streamable-http']),
};
const McpHostServerSnapshotSchema = Schema.Union(
  [
    Schema.Struct({
      ...McpHostServerSnapshotFields,
      state: Schema.Literals([
        'disconnected',
        'connecting',
        'authentication-required',
        'authorizing',
        'closing',
      ]),
    }),
    Schema.Struct({
      ...McpHostServerSnapshotFields,
      error: McpHostErrorSchema,
      state: Schema.Literal('error'),
    }),
    Schema.Struct({
      ...McpHostServerSnapshotFields,
      catalog: Schema.optional(McpHostCatalogWireSchema),
      negotiated: McpNegotiatedStatusSchema,
      state: Schema.Literal('connected'),
    }),
  ],
  { mode: 'oneOf' }
);
const McpHostSnapshotSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  servers: Schema.mutable(Schema.Array(McpHostServerSnapshotSchema)),
});
/** One server's host status, as a client outside the runtime's process receives it. */
export function parseMcpHostServerSnapshot(value: unknown): McpHostServerSnapshot {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostServerSnapshotSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value) as McpHostServerSnapshot;
}
/** The host's whole MCP status (a snapshot or a watch event), as a client outside its process receives it. */
export function parseMcpHostSnapshot(value: unknown): McpHostSnapshot {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostSnapshotSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value) as McpHostSnapshot;
}
const MCP_HOST_OPERATION_TYPES = [
  'completion/complete',
  'prompts/get',
  'prompts/list',
  'resources/list',
  'resources/read',
  'resources/subscribe',
  'resources/templates/list',
  'resources/unsubscribe',
  'tools/call',
  'tools/list',
] as const satisfies readonly McpHostOperationResult['type'][];
const McpHostOperationResultWireSchema = Schema.Struct({
  result: Schema.Record(Schema.String, McpHostJsonValueSchema),
  type: Schema.Literals(MCP_HOST_OPERATION_TYPES),
});
/**
 * An operation result as a client outside the host receives it (BST-1930 c5d):
 * its envelope, with the result as a strict-JSON object. The host validated
 * the result against the SDK's schema for its type before it crossed
 * (`./mcp-host-runtime`, node-only).
 */
export function parseMcpHostOperationResultWire(value: unknown): McpHostOperationResult {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostOperationResultWireSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value) as McpHostOperationResult;
}
