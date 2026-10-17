import { type FlexibleSchema, jsonSchema, TypeValidationError } from 'ai';

/** Keep the authority's JSON Schema and validator intact, including 2020-12 composition. */
export function executableInputSchema<Input>(input: FlexibleSchema<Input>): FlexibleSchema<Input> {
  if (
    typeof input === 'function' ||
    !('~standard' in input) ||
    input['~standard'].vendor === 'zod'
  ) {
    return input;
  }
  const standard = input['~standard'];
  if (!('jsonSchema' in standard && standard.jsonSchema)) {
    throw new Error('Executable Standard Schema must expose its model-facing JSON Schema');
  }
  const converter = standard.jsonSchema;
  return jsonSchema(() => converter.input({ target: 'draft-07' }), {
    validate: async (value) => {
      const result = await standard.validate(value);
      return 'value' in result
        ? { success: true, value: result.value }
        : { error: new TypeValidationError({ cause: result.issues, value }), success: false };
    },
  });
}
