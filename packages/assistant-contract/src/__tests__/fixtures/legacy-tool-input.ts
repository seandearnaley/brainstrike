import { z } from 'zod';
import { normalizeProviderNulls } from '../../native-tools/schemas/provider-null-normalization.js';

/** Preconversion oracle only; never imported by production. */
export function providerCompatibleInputSchema<S extends z.ZodType>(schema: S) {
  const json = z.toJSONSchema(schema, { cycles: 'throw', io: 'input', reused: 'inline' });
  return z.preprocess((value) => normalizeProviderNulls(value, json), schema);
}

export function legacyJsonSchema(
  schema: z.ZodType,
  target: 'draft-07' | 'draft-2020-12' = 'draft-2020-12'
) {
  return z.toJSONSchema(schema, {
    cycles: 'throw',
    io: 'input',
    reused: 'inline',
    target,
    unrepresentable: 'any',
  });
}
