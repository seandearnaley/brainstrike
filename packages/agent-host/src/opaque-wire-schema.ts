import { Effect, Schema } from 'effect';

/**
 * Existing opaque wire decoders already validate and normalize their domain value.
 * Preserve their result and thrown failure, as the former unknown.transform did.
 * Structured first-party payloads use their authored Schema instead.
 */
export function opaqueWireSchema<Value>(decode: (input: unknown) => Value) {
  return Schema.declareConstructor<Value, unknown>()(
    [],
    () => (input) => Effect.sync(() => decode(input))
  );
}
