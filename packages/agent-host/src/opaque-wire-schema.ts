import { Effect, Schema } from 'effect';

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
