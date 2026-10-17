import { normalizeProviderNulls } from '@brainstrike/assistant-contract/native-tool-schemas';
import {
  type PublicSchema,
  type StandardSchemaWithJSON,
  toStandardSchema,
} from '@mastra/core/schema';
import type { z } from 'zod';

/** Structural view of the installed @mastra/schema-compat layer, supplied by composition. */
export interface CanonicalProviderSchemaLayer {
  processToCompatSchema<Output>(schema: PublicSchema<Output>): StandardSchemaWithJSON<Output>;
  shouldApply(): boolean;
}

/**
 * Feed jsonSchema + validate to installed AI SDK 7's jsonSchema() primitive.
 * Reuse the shipped per-provider conversion and authored input normalization;
 * do not hand a Mastra Standard Schema object to SDK 7 as if it were Zod.
 * Composition selects the installed layer for the actual provider/model.
 */
export function prepareProviderToolInputSchema<Schema extends z.ZodType>(
  original: Schema,
  layer: CanonicalProviderSchemaLayer
): {
  jsonSchema: Record<string, unknown>;
  validate(
    value: unknown
  ): Promise<{ success: true; value: z.output<Schema> } | { success: false; error: Error }>;
} {
  const authored = toStandardSchema(original);
  const json = authored['~standard'].jsonSchema.input({ target: 'draft-07' });
  const input = {
    '~standard': {
      ...authored['~standard'],
      validate: (value: unknown) =>
        authored['~standard'].validate(normalizeProviderNulls(value, json)),
    },
  };
  const compatible = layer.shouldApply()
    ? layer.processToCompatSchema(input)
    : toStandardSchema(input);
  return {
    jsonSchema: compatible['~standard'].jsonSchema.input({ target: 'draft-07' }),
    validate: async (value) => {
      const result = await compatible['~standard'].validate(structuredClone(value));
      return result.issues
        ? {
            error: new Error(result.issues.map((issue) => issue.message).join(', ')),
            success: false,
          }
        : // Mastra's PublicSchema<T> conflates preprocess input and output.
          // Its successful validator still delegates to this authored schema.
          { success: true, value: result.value as z.output<Schema> };
    },
  };
}
