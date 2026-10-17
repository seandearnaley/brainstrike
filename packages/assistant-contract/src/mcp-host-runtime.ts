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
import { Schema } from 'effect';
import type { McpHostCatalog, McpHostCloseReport, McpHostOperationResult } from './mcp-host.js';
import { McpHostErrorSchema } from './mcp-host.js';
import {
  assertMcpHostStrictJson,
  McpHostCatalogErrorsSchema,
  McpHostServerFeaturesSchema,
  McpHostSubscriptionStatusSchema,
  McpNegotiatedStatusSchema,
} from './mcp-host-status.js';
import type { McpNegotiatedStatus } from './mcp-status.js';
import { sdkSchema } from './sdk-schema.js';

const McpHostOperationResultEnvelopeSchema = Schema.Union(
  [
    Schema.Struct({ result: sdkSchema(ListToolsResultSchema), type: Schema.Literal('tools/list') }),
    Schema.Struct({ result: sdkSchema(CallToolResultSchema), type: Schema.Literal('tools/call') }),
    Schema.Struct({
      result: sdkSchema(ListResourcesResultSchema),
      type: Schema.Literal('resources/list'),
    }),
    Schema.Struct({
      result: sdkSchema(ListResourceTemplatesResultSchema),
      type: Schema.Literal('resources/templates/list'),
    }),
    Schema.Struct({
      result: sdkSchema(ReadResourceResultSchema),
      type: Schema.Literal('resources/read'),
    }),
    Schema.Struct({
      result: sdkSchema(ListPromptsResultSchema),
      type: Schema.Literal('prompts/list'),
    }),
    Schema.Struct({
      result: sdkSchema(GetPromptResultSchema),
      type: Schema.Literal('prompts/get'),
    }),
    Schema.Struct({
      result: sdkSchema(CompleteResultSchema),
      type: Schema.Literal('completion/complete'),
    }),
    Schema.Struct({
      result: sdkSchema(EmptyResultSchema),
      type: Schema.Literal('resources/subscribe'),
    }),
    Schema.Struct({
      result: sdkSchema(EmptyResultSchema),
      type: Schema.Literal('resources/unsubscribe'),
    }),
  ],
  { mode: 'oneOf' }
);
const McpHostCloseCounterSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const McpHostCloseReportSchema: Schema.ConstraintDecoder<McpHostCloseReport> = Schema.Struct({
  callbacksClosed: McpHostCloseCounterSchema,
  childProcessesClosed: McpHostCloseCounterSchema,
  clientsClosed: McpHostCloseCounterSchema,
  failures: Schema.mutable(Schema.Array(McpHostErrorSchema)),
  loopbackPortsClosed: McpHostCloseCounterSchema,
  probesClosed: McpHostCloseCounterSchema,
  requestsSettled: McpHostCloseCounterSchema,
  subscriptionsClosed: McpHostCloseCounterSchema,
});
const McpHostCatalogSchema = Schema.Struct({
  errors: McpHostCatalogErrorsSchema,
  features: McpHostServerFeaturesSchema,
  prompts: Schema.optional(sdkSchema(ListPromptsResultSchema)),
  resources: Schema.optional(sdkSchema(ListResourcesResultSchema)),
  resourceTemplates: Schema.optional(sdkSchema(ListResourceTemplatesResultSchema)),
  subscription: McpHostSubscriptionStatusSchema,
  tools: Schema.optional(sdkSchema(ListToolsResultSchema)),
});
export function parseMcpHostOperationResult(value: unknown): McpHostOperationResult {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostOperationResultEnvelopeSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value) as McpHostOperationResult;
}
export function parseMcpHostCatalog(value: unknown): McpHostCatalog {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostCatalogSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value) as McpHostCatalog;
}
export function parseMcpHostCloseReport(value: unknown): McpHostCloseReport {
  assertMcpHostStrictJson(value);
  return Schema.decodeUnknownSync(McpHostCloseReportSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpNegotiatedStatus(value: unknown): McpNegotiatedStatus {
  assertMcpHostStrictJson(value);
  const parsed = Schema.decodeUnknownSync(McpNegotiatedStatusSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
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
