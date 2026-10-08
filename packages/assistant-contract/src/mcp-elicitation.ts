/**
 * Browser-safe MCP elicitation wire contract (BST-1584).
 *
 * Desktop main owns the elicitation presenter authority
 * (`apps/desktop/src/mcp/elicitation-presenter.ts`); this module carries the
 * shapes that cross the preload bridge so the renderer consent dialog never
 * imports desktop-main or SDK code:
 *
 * - `McpElicitationPresentationWire` mirrors `McpElicitationPresentation`
 *   structurally (copied, not imported — the presenter's shape is derived from
 *   the official SDK's `ElicitRequestFormParams['requestedSchema']`, whose
 *   optional members admit `undefined`, so the schema wire types do too).
 * - `parseMcpElicitationSettlement` validates the renderer's answer into exactly
 *   the presenter's `settle()` input: unknown keys are rejected, `content` is
 *   accepted only with `action: 'accept'` and only carries the SDK's primitive
 *   elicitation values (string, number, boolean, string array), and
 *   `generation` must be a safe integer so a forged settlement can never bind a
 *   stale authority.
 */
import { z } from 'zod';
import {
  type ConfiguredMcpServerId,
  type McpHostCaller,
  McpHostCallerSchema,
  type McpHostOperation,
  parseConfiguredMcpServerId,
} from './mcp-host.js';
import type { McpConfiguredProtocol, McpStatusTransport } from './mcp-status.js';
import { type McpTaskHandle, McpTaskHandleSchema } from './mcp-task-presentation.js';

export const MCP_ELICITATION_PRESENTATION_ID_MAX_LENGTH = 256;
export const MCP_ELICITATION_REQUEST_ID_MAX_LENGTH = 256;
export const MCP_ELICITATION_STRING_FORMATS = ['email', 'uri', 'date', 'date-time'] as const;
export type McpElicitationStringFormat = (typeof MCP_ELICITATION_STRING_FORMATS)[number];

interface McpElicitationSchemaBaseWire {
  readonly description?: string | undefined;
  readonly title?: string | undefined;
}
export interface McpElicitationBooleanSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: boolean | undefined;
  readonly type: 'boolean';
}
export interface McpElicitationStringSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: string | undefined;
  readonly format?: McpElicitationStringFormat | undefined;
  readonly maxLength?: number | undefined;
  readonly minLength?: number | undefined;
  readonly type: 'string';
}
export interface McpElicitationNumberSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: number | undefined;
  readonly maximum?: number | undefined;
  readonly minimum?: number | undefined;
  readonly type: 'integer' | 'number';
}
export interface McpElicitationTitledOptionWire {
  readonly const: string;
  readonly title: string;
}
export interface McpElicitationUntitledSingleSelectSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: string | undefined;
  readonly enum: readonly string[];
  readonly enumNames?: readonly string[] | undefined;
  readonly type: 'string';
}
export interface McpElicitationTitledSingleSelectSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: string | undefined;
  readonly oneOf: readonly McpElicitationTitledOptionWire[];
  readonly type: 'string';
}
export interface McpElicitationUntitledMultiSelectSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: readonly string[] | undefined;
  readonly items: { readonly enum: readonly string[]; readonly type: 'string' };
  readonly maxItems?: number | undefined;
  readonly minItems?: number | undefined;
  readonly type: 'array';
}
export interface McpElicitationTitledMultiSelectSchemaWire extends McpElicitationSchemaBaseWire {
  readonly default?: readonly string[] | undefined;
  readonly items: { readonly anyOf: readonly McpElicitationTitledOptionWire[] };
  readonly maxItems?: number | undefined;
  readonly minItems?: number | undefined;
  readonly type: 'array';
}
export type McpElicitationPrimitiveSchemaWire =
  | McpElicitationBooleanSchemaWire
  | McpElicitationNumberSchemaWire
  | McpElicitationStringSchemaWire
  | McpElicitationTitledMultiSelectSchemaWire
  | McpElicitationTitledSingleSelectSchemaWire
  | McpElicitationUntitledMultiSelectSchemaWire
  | McpElicitationUntitledSingleSelectSchemaWire;
export interface McpElicitationRequestedSchemaWire {
  readonly properties: { readonly [name: string]: McpElicitationPrimitiveSchemaWire };
  readonly required?: readonly string[] | undefined;
  readonly type: 'object';
}

export interface McpElicitationOperationWire {
  readonly target?: string;
  readonly type: McpHostOperation['type'];
}
export interface McpElicitationServerIdentityWire {
  readonly name: string;
  readonly title?: string;
  readonly version: string;
  readonly websiteOrigin?: string;
}
export interface McpElicitationProvenanceWire {
  /** The host tool call that raised the input; supplied by the host, never by the request. */
  readonly caller?: McpHostCaller;
  readonly configuredProtocol: McpConfiguredProtocol;
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
  readonly invocationId: string;
  readonly negotiatedRevision: string;
  readonly operation: McpElicitationOperationWire;
  readonly requestId: number | string;
  readonly serverIdentity?: McpElicitationServerIdentityWire;
  /** Supplied only by the host's verified task binding, never by the request. */
  readonly taskHandle?: McpTaskHandle;
  readonly transport: McpStatusTransport;
}
export interface McpFormElicitationPresentationWire {
  readonly id: string;
  readonly message: string;
  readonly mode: 'form';
  readonly provenance: McpElicitationProvenanceWire;
  readonly requestedSchema: McpElicitationRequestedSchemaWire;
}
export interface McpUrlElicitationPresentationWire {
  readonly id: string;
  readonly message: string;
  readonly mode: 'url';
  readonly provenance: McpElicitationProvenanceWire;
  readonly url: string;
}
export type McpElicitationPresentationWire =
  | McpFormElicitationPresentationWire
  | McpUrlElicitationPresentationWire;

/** Main → renderer push when a pending presentation is finalized without the renderer's settlement. */
export interface McpElicitationRetiredWire {
  readonly code: string;
  readonly id: string;
}

const MCP_ELICITATION_OPERATION_TYPES = [
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
] as const satisfies readonly McpHostOperation['type'][];
// Two-way exhaustiveness: a new host operation type must be named above.
const operationTypesCovered: Exclude<
  McpHostOperation['type'],
  (typeof MCP_ELICITATION_OPERATION_TYPES)[number]
> extends never
  ? true
  : never = true;
void operationTypesCovered;

const SchemaBaseWire = { description: z.string().optional(), title: z.string().optional() };
const OptionalNumber = z.number().optional();
const TitledOptionWire = z.looseObject({ const: z.string(), title: z.string() });
// Server-authored schema objects keep members this contract does not name;
// the named members are typed. The host-authored envelope below is strict.
const McpElicitationPrimitiveSchemaWireSchema = z.union([
  z.looseObject({ ...SchemaBaseWire, default: z.boolean().optional(), type: z.literal('boolean') }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.number().optional(),
    maximum: OptionalNumber,
    minimum: OptionalNumber,
    type: z.enum(['integer', 'number']),
  }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.string().optional(),
    enum: z.array(z.string()),
    enumNames: z.array(z.string()).optional(),
    type: z.literal('string'),
  }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.string().optional(),
    oneOf: z.array(TitledOptionWire),
    type: z.literal('string'),
  }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.string().optional(),
    format: z.enum(MCP_ELICITATION_STRING_FORMATS).optional(),
    maxLength: OptionalNumber,
    minLength: OptionalNumber,
    type: z.literal('string'),
  }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.array(z.string()).optional(),
    items: z.looseObject({ enum: z.array(z.string()), type: z.literal('string') }),
    maxItems: OptionalNumber,
    minItems: OptionalNumber,
    type: z.literal('array'),
  }),
  z.looseObject({
    ...SchemaBaseWire,
    default: z.array(z.string()).optional(),
    items: z.looseObject({ anyOf: z.array(TitledOptionWire) }),
    maxItems: OptionalNumber,
    minItems: OptionalNumber,
    type: z.literal('array'),
  }),
]);
const SafeIntegerWire = z
  .number()
  .int()
  .refine((value) => Number.isSafeInteger(value), 'must be a safe integer');
const McpElicitationProvenanceWireSchema = z.strictObject({
  caller: McpHostCallerSchema.exactOptional(),
  configuredProtocol: z.enum(['2026-07-28', 'auto', 'legacy']),
  configuredServerId: z.string().transform((value, ctx): ConfiguredMcpServerId => {
    try {
      return parseConfiguredMcpServerId(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a configured MCP server id' });
      return z.NEVER;
    }
  }),
  generation: SafeIntegerWire,
  invocationId: z.string().min(1),
  negotiatedRevision: z.string().min(1),
  operation: z.strictObject({
    target: z.string().exactOptional(),
    type: z.enum(MCP_ELICITATION_OPERATION_TYPES),
  }),
  requestId: z.union([z.string().max(MCP_ELICITATION_REQUEST_ID_MAX_LENGTH), SafeIntegerWire]),
  serverIdentity: z
    .strictObject({
      name: z.string(),
      title: z.string().exactOptional(),
      version: z.string(),
      websiteOrigin: z.string().exactOptional(),
    })
    .exactOptional(),
  taskHandle: McpTaskHandleSchema.exactOptional(),
  transport: z.enum(['sse', 'stdio', 'streamable-http']),
});
const PresentationBase = {
  id: z.string().min(1).max(MCP_ELICITATION_PRESENTATION_ID_MAX_LENGTH),
  message: z.string(),
  provenance: McpElicitationProvenanceWireSchema,
};
/**
 * Validates an `McpElicitationPresentationWire` as the agent host commits it
 * to the run log for its clients. The host-authored envelope and provenance
 * are strict; the server-authored requested schema keeps unnamed members.
 */
export const McpElicitationPresentationWireSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...PresentationBase,
    mode: z.literal('form'),
    requestedSchema: z.looseObject({
      properties: z.record(z.string(), McpElicitationPrimitiveSchemaWireSchema),
      required: z.array(z.string()).optional(),
      type: z.literal('object'),
    }),
  }),
  z.strictObject({ ...PresentationBase, mode: z.literal('url'), url: z.string().min(1) }),
]);
// The committed shape is the browser-safe wire the consent dialog renders.
const presentationWireAssignable: z.output<
  typeof McpElicitationPresentationWireSchema
> extends McpElicitationPresentationWire
  ? true
  : never = true;
void presentationWireAssignable;

/** Accepted form values mirror the SDK's `ElicitResult['content']` primitive set. */
export type McpElicitationContentValue = boolean | number | string | string[];
const McpElicitationContentValueSchema: z.ZodType<McpElicitationContentValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
const SafeIntegerSchema = z
  .number()
  .int()
  .refine((value) => Number.isSafeInteger(value), 'must be a safe integer');
const RequestIdSchema = z.union([
  z.string().max(MCP_ELICITATION_REQUEST_ID_MAX_LENGTH),
  SafeIntegerSchema,
]);
const SettlementBase = {
  configuredServerId: z.string().transform((value, ctx): ConfiguredMcpServerId => {
    try {
      return parseConfiguredMcpServerId(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a configured MCP server id' });
      return z.NEVER;
    }
  }),
  generation: SafeIntegerSchema,
  id: z.string().min(1).max(MCP_ELICITATION_PRESENTATION_ID_MAX_LENGTH),
  requestId: RequestIdSchema,
} as const;
const McpElicitationSettlementSchema = z.discriminatedUnion('action', [
  z.strictObject({
    ...SettlementBase,
    action: z.literal('accept'),
    content: z.record(z.string(), McpElicitationContentValueSchema).optional(),
  }),
  z.strictObject({ ...SettlementBase, action: z.literal('cancel') }),
  z.strictObject({ ...SettlementBase, action: z.literal('decline') }),
]);

export type McpElicitationSettlement = z.output<typeof McpElicitationSettlementSchema>;

export function parseMcpElicitationSettlement(value: unknown): McpElicitationSettlement {
  const result = McpElicitationSettlementSchema.safeParse(value);
  if (!result.success) {
    const diagnostics = result.error.issues
      .map(({ message, path }) => (path.length > 0 ? `${path.join('.')}: ${message}` : message))
      .join('; ');
    throw new Error(`Invalid MCP elicitation settlement: ${diagnostics}`);
  }
  return result.data;
}
