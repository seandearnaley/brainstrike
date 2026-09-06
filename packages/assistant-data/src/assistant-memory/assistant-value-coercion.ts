export function normalizeDate(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Invalid timestamp value');
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  throw new Error(`Invalid timestamp value: ${String(value)}`);
}

export function normalizeNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeDate(value);
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Mastra memory row: ${fieldName} is not a string.`);
  }
  return value;
}

export function requireNonEmptyTopologyId(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Assistant message topology ${fieldName} must be a non-empty string.`);
  }
  return value;
}

/**
 * Validate a usage token count before persistence. Malformed values THROW —
 * there is no silent coercion to 0 (see AGENTS.md "no silent fallbacks").
 */
export function assertUsageTokenCount(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Assistant run usage ${fieldName} must be a non-negative safe integer.`);
  }
}

/**
 * Coerce a SUM() aggregate (PGlite returns ::bigint as a string) into a
 * non-negative integer, throwing if the DB hands back something unparseable.
 */
export function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!(Number.isFinite(parsed) && Number.isInteger(parsed)) || parsed < 0) {
    throw new Error(`Invalid run usage aggregate: ${fieldName} is not a non-negative integer.`);
  }
  return parsed;
}

export function optionalNonNegativeFiniteNumber(
  value: unknown,
  fieldName: string
): number | undefined {
  if (value === null || value === undefined) {
    return;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid run usage aggregate: ${fieldName} is not a non-negative number.`);
  }
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function optionalJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return optionalRecord(parsed);
}

export function getRowValue(
  row: Record<string, unknown>,
  camelKey: string,
  snakeKey: string
): unknown {
  return row[camelKey] ?? row[snakeKey];
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Char cap for a rendered root display name (mirrors the SUBSTR in the SQL). */
export const MAX_ROOT_DISPLAY_NAME_CHARS = 512;

export function boundedNullableString(value: unknown, maxChars: number): string | null {
  const text = nullableString(value);
  if (text === null) {
    return text;
  }
  // Slice by code POINTS, not UTF-16 code units, so this actually mirrors the
  // SQL `SUBSTR(..., 1, N)` (which counts characters): a name ending in a
  // surrogate-pair grapheme (e.g. an emoji) at the boundary never leaves a lone
  // surrogate. `[...text]` iterates code points.
  const codePoints = [...text];
  return codePoints.length <= maxChars ? text : codePoints.slice(0, maxChars).join('');
}

export function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
