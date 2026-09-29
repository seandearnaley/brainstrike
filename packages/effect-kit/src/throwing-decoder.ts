import { Cause, Exit, Schema } from 'effect';

/**
 * Builds a synchronous decoder for code that reports bad data by throwing,
 * such as a repository mapping PGlite rows.
 *
 * A failure throws a `TypeError` whose message is the schema's own: a custom
 * `message` annotation on the failing schema or check, followed by the path to
 * the failing field. The `SchemaError` is kept as `cause`. Decoding stops at
 * the first failure.
 */
export function makeThrowingDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): (input: unknown) => S['Type'] {
  const decode = Schema.decodeUnknownExit(schema);
  return (input) => {
    const exit = decode(input);
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    const failure = Cause.squash(exit.cause);
    throw new TypeError(failure instanceof Error ? failure.message : String(failure), {
      cause: failure,
    });
  };
}
