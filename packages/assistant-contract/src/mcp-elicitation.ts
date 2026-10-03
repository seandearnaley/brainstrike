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
  type McpHostOperation,
  parseConfiguredMcpServerId,
} from './mcp-host.js';
import type { McpConfiguredProtocol, McpStatusTransport } from './mcp-status.js';
import type { McpTaskHandle } from './mcp-task-presentation.js';

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
