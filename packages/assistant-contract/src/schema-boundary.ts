import { Option, Schema, SchemaGetter, SchemaParser } from 'effect';

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
