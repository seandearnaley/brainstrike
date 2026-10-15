import { z } from 'zod';
import { isEffectToolInputSchema, type ToolJsonSchemaTarget } from './effect-tool-input.js';

/**
 * Reading a native tool's registered input schema without caring which library
 * authored it.
 *
 * ADR-0004 (amended 2026-10-15) makes Effect Schema the single boundary owner
 * and the remaining zod tool schemas are being converted behind it. Every tool
 * has exactly ONE producer; these accessors narrow to it. They are not a
 * fallback chain — a value neither producer made throws, because a tool whose
 * schema cannot be read must fail where it is declared rather than reach a
 * provider or an executor degraded.
 */

/**
 * The zod producer's JSON Schema options. `io: 'input'` unwraps the
 * `z.preprocess` every zod tool schema is wrapped in, so the result describes
 * what the model sends rather than what the executor receives.
 */
const ZOD_JSON_SCHEMA_OPTIONS = {
  cycles: 'throw',
  io: 'input',
  reused: 'inline',
  unrepresentable: 'any',
} as const;

/**
 * The dialect the inspector and the catalog sweeps read. It is stated rather
 * than defaulted: the two producers pick different dialects when asked for
 * none, and a comparison across them would then be between documents in
 * different drafts. The provider wire is draft-07 — that is what
 * `prepareHostProviderTools` requests and what the recorded provider payloads
 * carry — so a caller reasoning about the wire passes that explicitly.
 */
export const TOOL_DISPLAY_JSON_SCHEMA_TARGET = 'draft-2020-12' satisfies ToolJsonSchemaTarget;

/** Standard Schema reports a path segment either bare or wrapped in `{ key }`. */
function toToolInputIssue(issue: {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}): ToolInputIssue {
  return {
    message: issue.message,
    path: (issue.path ?? []).map((segment) =>
      typeof segment === 'object' ? segment.key : segment
    ),
  };
}

/** One issue in the shape both producers' failures are reported in. */
export interface ToolInputIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type ToolInputValidation<Value = unknown> =
  | { readonly issues: readonly ToolInputIssue[]; readonly success: false }
  | { readonly success: true; readonly value: Value };

/**
 * The model-facing JSON Schema of a tool's registered input schema, in the
 * dialect the caller names. Both producers answer in that dialect or throw.
 */
export function toToolInputJsonSchema(
  schema: unknown,
  target: ToolJsonSchemaTarget = TOOL_DISPLAY_JSON_SCHEMA_TARGET
): Record<string, unknown> {
  if (isEffectToolInputSchema(schema)) {
    return schema['~standard'].jsonSchema.input({ target });
  }
  if (schema instanceof z.ZodType) {
    return z.toJSONSchema(schema, { ...ZOD_JSON_SCHEMA_OPTIONS, target }) as Record<
      string,
      unknown
    >;
  }
  throw new TypeError('Tool input schema was authored by neither the zod nor the Effect producer');
}

/**
 * Validate tool input against its registered schema.
 *
 * The Effect producer's validator may be asynchronous in principle; every
 * schema declared here decodes synchronously, so a returned promise is a
 * declaration bug and is refused rather than awaited behind the caller's back.
 */
export function validateToolInputValue(schema: unknown, value: unknown): ToolInputValidation {
  if (isEffectToolInputSchema(schema)) {
    const result = schema['~standard'].validate(value);
    if (result instanceof Promise) {
      throw new TypeError('Tool input schema validated asynchronously');
    }
    return 'issues' in result
      ? { issues: result.issues.map(toToolInputIssue), success: false }
      : { success: true, value: result.value };
  }
  if (schema instanceof z.ZodType) {
    const result = schema.safeParse(value);
    return result.success
      ? { success: true, value: result.data }
      : {
          issues: result.error.issues.map((issue) => ({
            message: issue.message,
            path: [...issue.path],
          })),
          success: false,
        };
  }
  throw new TypeError('Tool input schema was authored by neither the zod nor the Effect producer');
}
