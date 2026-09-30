import { Cause, Exit, Schema, type SchemaAST } from 'effect';

/**
 * Builds a synchronous decoder for code that reports bad data by throwing,
 * such as a repository mapping PGlite rows.
 *
 * A failure throws a `TypeError` whose message is the schema's own: a custom
 * `message` annotation on the failing schema or check, followed by the path to
 * the failing field. The `SchemaError` is kept as `cause`. Decoding stops at
 * the first failure.
 *
 * `parseOptions` is Effect's own bag; `{ onExcessProperty: 'error' }` makes an
 * unknown key a failure that names the key, for a persisted format that must
 * not drift silently. The default ignores unknown keys, as Schema does.
 */
export function makeThrowingDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  parseOptions?: SchemaAST.ParseOptions
): (input: unknown) => S['Type'] {
  const decode = Schema.decodeUnknownExit(schema);
  return (input) => {
    const exit = decode(input, parseOptions);
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.squash(exit.cause);
    throw new TypeError(failure instanceof Error ? failure.message : String(failure), {
      cause: failure,
    });
  };
}
