import { z } from 'zod';
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
const McpHostJsonValueSchema: z.ZodType<McpHostJsonValue> = z.json();
export const McpHostServerFeaturesSchema = z.strictObject({
  completion: z.boolean(),
  promptListChanged: z.boolean(),
  prompts: z.boolean(),
  resourceListChanged: z.boolean(),
  resourceSubscriptions: z.boolean(),
  resources: z.boolean(),
  toolListChanged: z.boolean(),
  tools: z.boolean(),
});
const McpHostSubscriptionFilterSchema = z.strictObject({
  promptsListChanged: z.boolean().optional(),
  resourceSubscriptions: z.array(McpResourceUriSchema).optional(),
  resourcesListChanged: z.boolean().optional(),
  toolsListChanged: z.boolean().optional(),
});
export const McpHostSubscriptionStatusSchema = z.strictObject({
  honoredFilter: McpHostSubscriptionFilterSchema.optional(),
  mode: z.enum(['legacy-unsolicited', 'modern-listen', 'none']),
  state: z.enum(['closed', 'listening', 'retrying', 'unsupported']),
});
export const McpHostCatalogErrorsSchema: z.ZodType<McpHostCatalogErrors> = z.partialRecord(
  z.enum(MCP_HOST_CATALOG_SECTIONS),
  McpHostErrorSchema
);
export const McpNegotiatedStatusSchema = z.strictObject({
  advertisedCapabilityIds: z.array(z.string()).optional(),
  era: z.enum(['legacy', 'modern']),
  revision: z.string(),
  serverIdentity: z
    .strictObject({
      description: z.string().optional(),
      name: z.string(),
      title: z.string().optional(),
      version: z.string(),
      websiteUrl: z.string().optional(),
    })
    .optional(),
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
    if (!McpHostJsonValueSchema.safeParse(value).success) {
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
const McpHostCatalogWireSchema = z.strictObject({
  errors: McpHostCatalogErrorsSchema,
  features: McpHostServerFeaturesSchema,
  prompts: McpHostJsonValueSchema.optional(),
  resources: McpHostJsonValueSchema.optional(),
  resourceTemplates: McpHostJsonValueSchema.optional(),
  subscription: McpHostSubscriptionStatusSchema,
  tools: McpHostJsonValueSchema.optional(),
});

const McpHostAuthSnapshotSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({
    credentialState: z.enum(['malformed', 'missing', 'stored', 'unreadable']),
    type: z.literal('bearer'),
  }),
  z.strictObject({
    authorizationServer: z.string().optional(),
    credentialState: z.enum(['missing', 'stored', 'unreadable']),
    grantedScopes: z.array(z.string()),
    lastSuccessfulConnectionAt: z.number().optional(),
    requestedScopes: z.array(z.string()),
    resourceUrl: z.string(),
    type: z.literal('oauth-user'),
  }),
]);
const McpHostServerSnapshotFields = {
  auth: McpHostAuthSnapshotSchema.optional(),
  configuredProtocol: z.enum(['2026-07-28', 'auto', 'legacy']),
  configuredServerId: ConfiguredMcpServerIdSchema,
  diagnostics: z
    .array(
      z.strictObject({
        message: z.string(),
        stream: z.literal('stderr'),
        truncated: z.boolean(),
      })
    )
    .max(MCP_HOST_DIAGNOSTIC_MAX_ENTRIES)
    .optional(),
  enabledTools: z.array(z.string()).optional(),
  extensions: McpExtensionEnablementSchema.optional(),
  generation: z.number().int().positive(),
  transport: z.enum(['sse', 'stdio', 'streamable-http']),
};
const McpHostServerSnapshotSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...McpHostServerSnapshotFields,
    state: z.enum([
      'disconnected',
      'connecting',
      'authentication-required',
      'authorizing',
      'closing',
    ]),
  }),
  z.strictObject({
    ...McpHostServerSnapshotFields,
    error: McpHostErrorSchema,
    state: z.literal('error'),
  }),
  z.strictObject({
    ...McpHostServerSnapshotFields,
    catalog: McpHostCatalogWireSchema.optional(),
    negotiated: McpNegotiatedStatusSchema,
    state: z.literal('connected'),
  }),
]);
const McpHostSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  servers: z.array(McpHostServerSnapshotSchema),
});

/** One server's host status, as a client outside the runtime's process receives it. */
export function parseMcpHostServerSnapshot(value: unknown): McpHostServerSnapshot {
  assertMcpHostStrictJson(value);
  return McpHostServerSnapshotSchema.parse(value) as McpHostServerSnapshot;
}

/** The host's whole MCP status (a snapshot or a watch event), as a client outside its process receives it. */
export function parseMcpHostSnapshot(value: unknown): McpHostSnapshot {
  assertMcpHostStrictJson(value);
  return McpHostSnapshotSchema.parse(value) as McpHostSnapshot;
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
const McpHostOperationResultWireSchema = z.strictObject({
  result: z.record(z.string(), McpHostJsonValueSchema),
  type: z.enum(MCP_HOST_OPERATION_TYPES),
});

/**
 * An operation result as a client outside the host receives it (BST-1930 c5d):
 * its envelope, with the result as a strict-JSON object. The host validated
 * the result against the SDK's schema for its type before it crossed
 * (`./mcp-host-runtime`, node-only).
 */
export function parseMcpHostOperationResultWire(value: unknown): McpHostOperationResult {
  assertMcpHostStrictJson(value);
  return McpHostOperationResultWireSchema.parse(value) as McpHostOperationResult;
}
