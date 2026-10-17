import { Schema } from 'effect';
export type Json = (typeof Schema.MutableJson)['Type'];
/**
 * The JSON value schema an event schema is built over: `Schema.MutableJson` for producers
 * and the wire, or the stored-row reader's, which accepts JSON.parse output as
 * it is (ADR-0011).
 */
export type JsonSchemaFactory = () => Schema.ConstraintDecoder<Json>;
/**
 * ADR-0011: a stored row's JSON values came out of JSON.parse, which yields
 * nothing `Schema.MutableJson` rejects, so stored-row decoding accepts them without
 * walking them again. A missing value is still refused, and every structural
 * field around it is still validated.
 */
export const storedJson: JsonSchemaFactory = () =>
  Schema.declare((value: unknown): value is Json => value !== undefined, {
    message: 'Expected a stored JSON value',
  });
export function jsonValue(value: unknown): Json {
  return Schema.decodeUnknownSync(Schema.MutableJson)(JSON.parse(JSON.stringify(value)));
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
