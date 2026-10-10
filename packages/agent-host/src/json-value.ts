import { z } from 'zod';

export type Json = z.infer<ReturnType<typeof z.json>>;

/**
 * The JSON value schema an event schema is built over: `z.json` for producers
 * and the wire, or the stored-row reader's, which accepts JSON.parse output as
 * it is (ADR-0011).
 */
export type JsonSchemaFactory = () => z.ZodType<Json>;

/**
 * ADR-0011: a stored row's JSON values came out of JSON.parse, which yields
 * nothing `z.json()` rejects, so stored-row decoding accepts them without
 * walking them again. A missing value is still refused, and every structural
 * field around it is still validated.
 */
export const storedJson: JsonSchemaFactory = () =>
  z.custom<Json>((value) => value !== undefined, { message: 'Expected a stored JSON value' });

export function jsonValue(value: unknown): Json {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
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
