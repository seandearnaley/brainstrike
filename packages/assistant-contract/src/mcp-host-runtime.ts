import {
  CallToolResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod';
import { McpExtensionEnablementSchema } from './mcp-extensions.js';
import type {
  McpHostCatalog,
  McpHostCatalogErrors,
  McpHostCloseReport,
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
import type { McpNegotiatedStatus } from './mcp-status.js';

const McpHostOperationResultEnvelopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ result: ListToolsResultSchema, type: z.literal('tools/list') }),
  z.strictObject({ result: CallToolResultSchema, type: z.literal('tools/call') }),
  z.strictObject({ result: ListResourcesResultSchema, type: z.literal('resources/list') }),
  z.strictObject({
    result: ListResourceTemplatesResultSchema,
    type: z.literal('resources/templates/list'),
  }),
  z.strictObject({ result: ReadResourceResultSchema, type: z.literal('resources/read') }),
  z.strictObject({ result: ListPromptsResultSchema, type: z.literal('prompts/list') }),
  z.strictObject({ result: GetPromptResultSchema, type: z.literal('prompts/get') }),
  z.strictObject({ result: CompleteResultSchema, type: z.literal('completion/complete') }),
  z.strictObject({ result: EmptyResultSchema, type: z.literal('resources/subscribe') }),
  z.strictObject({ result: EmptyResultSchema, type: z.literal('resources/unsubscribe') }),
]);
const McpHostJsonValueSchema: z.ZodType<McpHostJsonValue> = z.json();
const McpHostCloseCounterSchema = z.number().int().nonnegative().safe();
const McpHostCloseReportSchema: z.ZodType<McpHostCloseReport> = z.strictObject({
  callbacksClosed: McpHostCloseCounterSchema,
  childProcessesClosed: McpHostCloseCounterSchema,
  clientsClosed: McpHostCloseCounterSchema,
  failures: z.array(McpHostErrorSchema),
  loopbackPortsClosed: McpHostCloseCounterSchema,
  probesClosed: McpHostCloseCounterSchema,
  requestsSettled: McpHostCloseCounterSchema,
  subscriptionsClosed: McpHostCloseCounterSchema,
});
const McpHostServerFeaturesSchema = z.strictObject({
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
const McpHostSubscriptionStatusSchema = z.strictObject({
  honoredFilter: McpHostSubscriptionFilterSchema.optional(),
  mode: z.enum(['legacy-unsolicited', 'modern-listen', 'none']),
  state: z.enum(['closed', 'listening', 'retrying', 'unsupported']),
});
const McpHostCatalogErrorsSchema: z.ZodType<McpHostCatalogErrors> = z.partialRecord(
  z.enum(MCP_HOST_CATALOG_SECTIONS),
  McpHostErrorSchema
);
const McpHostCatalogSchema = z.strictObject({
  errors: McpHostCatalogErrorsSchema,
  features: McpHostServerFeaturesSchema,
  prompts: ListPromptsResultSchema.optional(),
  resources: ListResourcesResultSchema.optional(),
  resourceTemplates: ListResourceTemplatesResultSchema.optional(),
  subscription: McpHostSubscriptionStatusSchema,
  tools: ListToolsResultSchema.optional(),
});
const McpNegotiatedStatusSchema = z.strictObject({
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

function assertStrictJson(
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
      assertStrictJson(child, childPath, active, done);
    }
  } finally {
    active.delete(value);
  }
  done.add(value);
}

export function parseMcpHostOperationResult(value: unknown): McpHostOperationResult {
  assertStrictJson(value);
  return McpHostOperationResultEnvelopeSchema.parse(value) as McpHostOperationResult;
}

export function parseMcpHostCatalog(value: unknown): McpHostCatalog {
  assertStrictJson(value);
  return McpHostCatalogSchema.parse(value) as McpHostCatalog;
}

export function parseMcpHostCloseReport(value: unknown): McpHostCloseReport {
  assertStrictJson(value);
  return McpHostCloseReportSchema.parse(value);
}

export function parseMcpNegotiatedStatus(value: unknown): McpNegotiatedStatus {
  assertStrictJson(value);
  const parsed = McpNegotiatedStatusSchema.parse(value);
  const serverIdentity = parsed.serverIdentity;
  return {
    ...(parsed.advertisedCapabilityIds === undefined
      ? {}
      : { advertisedCapabilityIds: parsed.advertisedCapabilityIds }),
    era: parsed.era,
    revision: parsed.revision,
    ...(serverIdentity === undefined
      ? {}
      : {
          serverIdentity: {
            ...(serverIdentity.description === undefined
              ? {}
              : { description: serverIdentity.description }),
            name: serverIdentity.name,
            ...(serverIdentity.title === undefined ? {} : { title: serverIdentity.title }),
            version: serverIdentity.version,
            ...(serverIdentity.websiteUrl === undefined
              ? {}
              : { websiteUrl: serverIdentity.websiteUrl }),
          },
        }),
  };
}

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
    catalog: McpHostCatalogSchema.optional(),
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
  assertStrictJson(value);
  return McpHostServerSnapshotSchema.parse(value) as McpHostServerSnapshot;
}

/** The host's whole MCP status (a snapshot or a watch event), as a client outside its process receives it. */
export function parseMcpHostSnapshot(value: unknown): McpHostSnapshot {
  assertStrictJson(value);
  return McpHostSnapshotSchema.parse(value) as McpHostSnapshot;
}
