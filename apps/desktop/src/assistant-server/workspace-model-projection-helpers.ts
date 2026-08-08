export interface WorkspaceTextModelOutput {
  type: 'text';
  value: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function projectionSingleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function escapeProjectionPathLineBreaks(value: string): string {
  return value
    .replace(/\r/gu, String.raw`\r`)
    .replace(/\n/gu, String.raw`\n`)
    .replace(/\u2028/gu, String.raw`\u2028`)
    .replace(/\u2029/gu, String.raw`\u2029`);
}

export function clipProjectionEnd(value: string, maxChars: number, label: string): string {
  const normalized = projectionSingleLine(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) {
    return normalized;
  }
  return `${codePoints.slice(0, maxChars).join('')}…[${
    codePoints.length - maxChars
  } ${label} chars omitted]`;
}

export function clipProjectionMiddle(value: string, maxChars: number, label: string): string {
  // Callers must pre-normalize line breaks or deliberately preserve path whitespace.
  const codePoints = Array.from(value);
  if (codePoints.length <= maxChars) {
    return value;
  }
  const keptAtEachEnd = Math.floor(maxChars / 2);
  const omitted = codePoints.length - keptAtEachEnd * 2;
  return `${codePoints.slice(0, keptAtEachEnd).join('')}…[${omitted} ${label} clipped]…${codePoints
    .slice(-keptAtEachEnd)
    .join('')}`;
}

export function makeWorkspaceTextModelOutput(lines: readonly string[]): WorkspaceTextModelOutput {
  return { type: 'text', value: lines.join('\n') };
}

/**
 * Fixed reserve added on top of the decoded value length when measuring a
 * domain projection against MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET.
 *
 * Value derivation (BST-1195): the OLD ruler measured
 * `JSON.stringify({ type: 'text', value }).length`, which for the empty
 * string is exactly 26 (`{"type":"text","value":""}.length === 26`) — the
 * fixed structural overhead of the envelope. JSON escaping can only ADD
 * characters relative to the raw string (never remove), and code-point
 * counting can only be <= UTF-16 length (astral pairs collapse). Therefore
 * for ANY string X: codePointLength(X) + 26 <= JSON.stringify({type:'text',
 * value:X}).length. Using 26 here guarantees the new (decoded) measurement
 * is NEVER larger than the old (serialized) measurement was for the same
 * text — a stored projection that fit the old budget is guaranteed to still
 * fit the new one on replay. Do not "round up" this constant without
 * re-deriving the proof above.
 */
export const PROJECTION_ENVELOPE_RESERVE_CHARS = 26;

/**
 * The ONE domain-projection budget ruler (BST-1195). Tokens come from the
 * DECODED string the model actually reads, where a literal newline is ONE
 * character — not from the JSON-serialized `{"type":"text","value":"..."}`
 * envelope, which doubles every newline/quote/backslash. Every domain
 * projector MUST measure fit through this function against
 * MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET; no site-local
 * JSON.stringify(...).length math is allowed. Pass the same `lines` array
 * you would pass to makeWorkspaceTextModelOutput; for a value you already
 * have as a single string (e.g. replaying a stored projection's `value`
 * field), pass it as a one-element array `[value]`.
 */
export function decodedWorkspaceTextModelOutputChars(lines: readonly string[]): number {
  return Array.from(lines.join('\n')).length + PROJECTION_ENVELOPE_RESERVE_CHARS;
}
