import {
  type McpElicitationPresentationWire,
  type McpElicitationSettlement,
  McpTaskActionRequestSchema,
  McpTaskActionResultSchema,
  McpTaskListResultSchema,
  McpTaskPresentationSchema,
  parseMcpElicitationPresentation,
  parseMcpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import { opaqueWireSchema } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

/**
 * The desktop's MCP presentations (BST-1930 c5c): durable Tasks status cards
 * with their recover and cancel actions, and server input (elicitation) that no
 * run owns. The host's task host and elicitation presenter own them; the
 * desktop's windows read and answer them through these methods and hear each
 * change through `mcp/presentation/event`.
 */
const McpElicitationPresentationWireSchema: Schema.ConstraintDecoder<McpElicitationPresentationWire> =
  opaqueWireSchema(
    (value): McpElicitationPresentationWire => parseMcpElicitationPresentation(value)
  );
const McpElicitationSettlementWireSchema: Schema.ConstraintDecoder<McpElicitationSettlement> =
  opaqueWireSchema((value): McpElicitationSettlement => parseMcpElicitationSettlement(value));
/** Host -> subscribed client: a task's presentation changed, or server input arrived or ended. */
export const MCP_PRESENTATION_EVENT = 'mcp/presentation/event';
export const McpPresentationEventSchema = Schema.Union(
  [
    Schema.Struct({ task: McpTaskPresentationSchema, type: Schema.Literal('task') }),
    Schema.Struct({
      presentation: McpElicitationPresentationWireSchema,
      type: Schema.Literal('elicitation.requested'),
    }),
    Schema.Struct({
      code: Schema.String.check(Schema.isMinCodePoints(1)),
      id: Schema.String.check(Schema.isMinCodePoints(1)),
      type: Schema.Literal('elicitation.retired'),
    }),
  ],
  { mode: 'oneOf' }
);
export type McpPresentationEvent = (typeof McpPresentationEventSchema)['Type'];
const None = Schema.Record(Schema.String, Schema.Never);
export const MCP_PRESENTATION_METHOD_SCHEMAS = {
  /** Answer one presented server input: accept (with content), decline or cancel. */
  'mcp/elicitation/settle': McpElicitationSettlementWireSchema,
  'mcp/presentation/subscribe': None,
  /** Recover or cancel one task through its card. */
  'mcp/tasks/act': McpTaskActionRequestSchema,
  'mcp/tasks/list': None,
} as const;
export const MCP_PRESENTATION_RESULT_SCHEMAS = {
  'mcp/elicitation/settle': Schema.Struct({ settled: Schema.Literal(true) }),
  'mcp/presentation/subscribe': McpTaskListResultSchema,
  'mcp/tasks/act': McpTaskActionResultSchema,
  'mcp/tasks/list': McpTaskListResultSchema,
} as const;
