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
import { z } from 'zod';

/**
 * The desktop's MCP presentations (BST-1930 c5c): durable Tasks status cards
 * with their recover and cancel actions, and server input (elicitation) that no
 * run owns. The host's task host and elicitation presenter own them; the
 * desktop's windows read and answer them through these methods and hear each
 * change through `mcp/presentation/event`.
 */
const McpElicitationPresentationWireSchema: z.ZodType<McpElicitationPresentationWire> = z
  .unknown()
  .transform((value): McpElicitationPresentationWire => parseMcpElicitationPresentation(value));
const McpElicitationSettlementWireSchema: z.ZodType<McpElicitationSettlement> = z
  .unknown()
  .transform((value): McpElicitationSettlement => parseMcpElicitationSettlement(value));

/** Host -> subscribed client: a task's presentation changed, or server input arrived or ended. */
export const MCP_PRESENTATION_EVENT = 'mcp/presentation/event';
export const McpPresentationEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ task: McpTaskPresentationSchema, type: z.literal('task') }),
  z.strictObject({
    presentation: McpElicitationPresentationWireSchema,
    type: z.literal('elicitation.requested'),
  }),
  z.strictObject({
    code: z.string().min(1),
    id: z.string().min(1),
    type: z.literal('elicitation.retired'),
  }),
]);
export type McpPresentationEvent = z.infer<typeof McpPresentationEventSchema>;

const None = z.strictObject({});

export const MCP_PRESENTATION_METHOD_SCHEMAS = {
  /** Answer one presented server input: accept (with content), decline or cancel. */
  'mcp/elicitation/settle': McpElicitationSettlementWireSchema,
  'mcp/presentation/subscribe': None,
  /** Recover or cancel one task through its card. */
  'mcp/tasks/act': McpTaskActionRequestSchema,
  'mcp/tasks/list': None,
} as const;

export const MCP_PRESENTATION_RESULT_SCHEMAS = {
  'mcp/elicitation/settle': z.strictObject({ settled: z.literal(true) }),
  'mcp/presentation/subscribe': McpTaskListResultSchema,
  'mcp/tasks/act': McpTaskActionResultSchema,
  'mcp/tasks/list': McpTaskListResultSchema,
} as const;
