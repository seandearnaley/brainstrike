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
const McpHostCatalogSchema = z.strictObject({
  errors: McpHostCatalogErrorsSchema,
  features: McpHostServerFeaturesSchema,
  prompts: ListPromptsResultSchema.optional(),
  resources: ListResourcesResultSchema.optional(),
  resourceTemplates: ListResourceTemplatesResultSchema.optional(),
  subscription: McpHostSubscriptionStatusSchema,
  tools: ListToolsResultSchema.optional(),
});
export function parseMcpHostOperationResult(value: unknown): McpHostOperationResult {
  assertMcpHostStrictJson(value);
  return McpHostOperationResultEnvelopeSchema.parse(value) as McpHostOperationResult;
}

export function parseMcpHostCatalog(value: unknown): McpHostCatalog {
  assertMcpHostStrictJson(value);
  return McpHostCatalogSchema.parse(value) as McpHostCatalog;
}

export function parseMcpHostCloseReport(value: unknown): McpHostCloseReport {
  assertMcpHostStrictJson(value);
  return McpHostCloseReportSchema.parse(value);
}

export function parseMcpNegotiatedStatus(value: unknown): McpNegotiatedStatus {
  assertMcpHostStrictJson(value);
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
