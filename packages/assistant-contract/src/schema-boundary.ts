import {
  Cause,
  Effect,
  Exit,
  Option,
  Result,
  Schema,
  type SchemaAST,
  SchemaGetter,
  SchemaParser,
} from 'effect';

/** An optional field whose existing boundary normalizer omits an own undefined value. */
export function omitUndefinedOptional<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.optional(schema).pipe(
    Schema.decodeTo(Schema.optionalKey(schema), {
      decode: SchemaGetter.transformOptional((value) =>
        Option.filter(value, (entry): entry is S['Type'] => entry !== undefined)
      ),
      encode: SchemaGetter.passthrough(),
    })
  );
}

/** A nested strict object keeps its policy when an enclosing DTO strips unknown keys. */
export function strictWireSchema<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.declareConstructor<S['Type'], S['Encoded']>()(
    [schema],
    ([owned]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(owned)(input, { ...options, onExcessProperty: 'error' })
  );
}

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

/**
 * Existing opaque wire decoders already validate and normalize their domain value.
 * Return their validated result. Receiving boundaries use wireDecoder /
 * wireResultDecoder so Effect defects keep the former unknown.transform failure.
 * Structured first-party payloads use their authored Schema instead.
 */
export function opaqueWireSchema<Value>(decode: (input: unknown) => Value) {
  return Schema.declareConstructor<Value, unknown>()(
    [],
    () => (input) => Effect.sync(() => decode(input))
  );
}
