import { isEffectToolInputSchema, type ToolJsonSchemaTarget } from './effect-tool-input.js';

/** Inspector uses 2020-12; provider callers explicitly request draft-07. */
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

/** One issue in the shape native input failures are reported in. */
export interface ToolInputIssue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

export type ToolInputValidation<Value = unknown> =
  | { readonly issues: readonly ToolInputIssue[]; readonly success: false }
  | { readonly success: true; readonly value: Value };

/**
 * The model-facing JSON Schema of a tool's registered input schema, in the
 * dialect the caller names. The producer answers in that dialect or throws.
 */
export function toToolInputJsonSchema(
  schema: unknown,
  target: ToolJsonSchemaTarget = TOOL_DISPLAY_JSON_SCHEMA_TARGET
): Record<string, unknown> {
  if (isEffectToolInputSchema(schema)) {
    return schema['~standard'].jsonSchema.input({ target });
  }
  throw new TypeError('Tool input schema was not authored by the Effect producer');
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
  throw new TypeError('Tool input schema was not authored by the Effect producer');
}
