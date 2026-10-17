import {
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
} from '@modelcontextprotocol/core';
import { Schema } from 'effect';
import type { McpElicitationPresentationWire } from './mcp-elicitation.js';
import {
  ConfiguredMcpServerIdSchema,
  McpConfiguredProtocolSchema,
  McpStatusTransportSchema,
} from './mcp-host.js';
import { McpTaskHandleSchema } from './mcp-task-presentation.js';
import { sdkSchema } from './sdk-schema.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const ProvenanceSchema = Schema.Struct({
  configuredProtocol: McpConfiguredProtocolSchema,
  configuredServerId: ConfiguredMcpServerIdSchema,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  invocationId: Id,
  negotiatedRevision: Id,
  operation: Schema.Struct({
    target: Schema.optional(Schema.String),
    type: Schema.Literals([
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
  requestId: Schema.Union([Id, Schema.Int]),
  serverIdentity: Schema.optional(
    Schema.Struct({
      name: Id,
      title: Schema.optional(Id),
      version: Schema.String,
      websiteOrigin: Schema.optional(Schema.String),
    })
  ),
  taskHandle: Schema.optional(McpTaskHandleSchema),
  transport: McpStatusTransportSchema,
});
const PresentationBase = {
  id: Id,
  message: sdkSchema(ElicitRequestFormParamsSchema.shape.message),
  provenance: ProvenanceSchema,
};
export const McpElicitationPresentationSchema = Schema.Union(
  [
    Schema.Struct({
      ...PresentationBase,
      mode: Schema.Literal('form'),
      requestedSchema: sdkSchema(ElicitRequestFormParamsSchema.shape.requestedSchema),
    }),
    Schema.Struct({
      ...PresentationBase,
      mode: Schema.Literal('url'),
      url: sdkSchema(ElicitRequestURLParamsSchema.shape.url),
    }),
  ],
  { mode: 'oneOf' }
);
export function parseMcpElicitationPresentation(input: unknown): McpElicitationPresentationWire {
  const result = Schema.decodeUnknownResult(McpElicitationPresentationSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  if (!(result._tag === 'Success')) {
    throw new Error('MCP input presentation is unavailable or stale');
  }
  const parsed = result.success;
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
