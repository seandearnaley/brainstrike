import {
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
} from '@modelcontextprotocol/core';
import { z } from 'zod';
import type { McpElicitationPresentationWire } from './mcp-elicitation.js';
import {
  ConfiguredMcpServerIdSchema,
  McpConfiguredProtocolSchema,
  McpStatusTransportSchema,
} from './mcp-host.js';
import { McpTaskHandleSchema } from './mcp-task-presentation.js';

const Id = z.string().min(1);
const ProvenanceSchema = z.strictObject({
  configuredProtocol: McpConfiguredProtocolSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
  generation: z.number().int().positive().safe(),
  invocationId: Id,
  negotiatedRevision: Id,
  operation: z.strictObject({
    target: z.string().optional(),
    type: z.enum([
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
      'completion/complete',
      'resources/subscribe',
      'resources/unsubscribe',
    ]),
  }),
  requestId: z.union([Id, z.number().int().safe()]),
  serverIdentity: z
    .strictObject({
      name: Id,
      title: Id.optional(),
      version: z.string(),
      websiteOrigin: z.string().optional(),
    })
    .optional(),
  taskHandle: McpTaskHandleSchema.optional(),
  transport: McpStatusTransportSchema,
});
const PresentationBase = {
  id: Id,
  message: ElicitRequestFormParamsSchema.shape.message,
  provenance: ProvenanceSchema,
};
export const McpElicitationPresentationSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...PresentationBase,
    mode: z.literal('form'),
    requestedSchema: ElicitRequestFormParamsSchema.shape.requestedSchema,
  }),
  z.strictObject({
    ...PresentationBase,
    mode: z.literal('url'),
    url: ElicitRequestURLParamsSchema.shape.url,
  }),
]);

export function parseMcpElicitationPresentation(input: unknown): McpElicitationPresentationWire {
  const result = McpElicitationPresentationSchema.safeParse(input);
  if (!result.success) {
    throw new Error('MCP input presentation is unavailable or stale');
  }
  const parsed = result.data;
  const { operation, serverIdentity, taskHandle, ...provenance } = parsed.provenance;
  return {
    ...parsed,
    provenance: {
      ...provenance,
      operation: {
        type: operation.type,
        ...(operation.target === undefined ? {} : { target: operation.target }),
      },
      ...(taskHandle === undefined ? {} : { taskHandle }),
      ...(serverIdentity === undefined
        ? {}
        : {
            serverIdentity: {
              name: serverIdentity.name,
              version: serverIdentity.version,
              ...(serverIdentity.title === undefined ? {} : { title: serverIdentity.title }),
              ...(serverIdentity.websiteOrigin === undefined
                ? {}
                : { websiteOrigin: serverIdentity.websiteOrigin }),
            },
          }),
    },
  };
}
