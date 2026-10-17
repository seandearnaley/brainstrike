import { normalizeProviderNulls } from '@brainstrike/assistant-contract/native-tool-schemas';
import { z } from 'zod';

/** Preconversion test oracle, never a production tool producer. */
export function providerCompatibleInputSchema<S extends z.ZodType>(schema: S) {
  let json: unknown;
  return z.preprocess((value) => {
    json ??= z.toJSONSchema(schema, { cycles: 'throw', io: 'input', reused: 'inline' });
    return normalizeProviderNulls(value, json);
  }, schema);
}
