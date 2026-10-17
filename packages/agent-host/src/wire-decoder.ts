import { Cause, Exit, Result, Schema, type SchemaAST } from 'effect';

/** Return schema refusals as data while preserving an owned domain decoder's thrown failure. */
export function wireResultDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: SchemaAST.ParseOptions
) {
  const decode = Schema.decodeUnknownExit(schema, options);
  return (
    input: unknown,
    overrideOptions?: SchemaAST.ParseOptions
  ): Result.Result<S['Type'], Schema.SchemaError> => {
    const exit = decode(input, overrideOptions);
    if (Exit.isSuccess(exit)) {
      return Result.succeed(exit.value);
    }
    const [first] = exit.cause.reasons;
    if (exit.cause.reasons.length === 1 && first && Cause.isFailReason(first)) {
      return Result.fail(first.error);
    }
    throw Cause.squash(exit.cause);
  };
}

/** The throwing form keeps both schema errors and domain failures intact. */
export function wireDecoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: SchemaAST.ParseOptions
) {
  const decode = wireResultDecoder(schema, options);
  return (input: unknown, overrideOptions?: SchemaAST.ParseOptions): S['Type'] => {
    const result = decode(input, overrideOptions);
    if (Result.isFailure(result)) {
      throw result.failure;
    }
    return result.success;
  };
}
