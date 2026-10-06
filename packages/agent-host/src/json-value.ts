import { z } from 'zod';

export type Json = z.infer<ReturnType<typeof z.json>>;

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
