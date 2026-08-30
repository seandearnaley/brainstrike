import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import type { McpHostCloseReport, McpHostJsonValue, McpHostOperationResult } from './mcp-host.js';
import { McpHostErrorSchema } from './mcp-host.js';
import type { McpNegotiatedStatus } from './mcp-status.js';

const McpHostOperationResultEnvelopeSchema = z.discriminatedUnion('type', [
  z.strictObject({ result: ListToolsResultSchema, type: z.literal('tools/list') }),
  z.strictObject({ result: CallToolResultSchema, type: z.literal('tools/call') }),
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
