import { Effect, Schema, SchemaIssue } from 'effect';
import type { z } from 'zod';

/** The SDK remains the sole grammar/decoder for an SDK-owned value. */
export function sdkSchema<Output, Input>(schema: z.ZodType<Output, Input>) {
  return Schema.declareConstructor<Output, Input>()([], () => (input, ast, options) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) {
      return Effect.succeed(parsed.data);
    }
    const issues = parsed.error.issues.map(
      (issue) =>
        new SchemaIssue.Pointer(
          issue.path,
          new SchemaIssue.InvalidValue({ message: issue.message }, undefined, options)
        )
    );
    const [first, ...rest] = issues;
    if (!first) {
      throw new Error('An SDK schema refused a value without an issue');
    }
    return Effect.fail(new SchemaIssue.Composite(ast, [first, ...rest], undefined, options));
  });
}
