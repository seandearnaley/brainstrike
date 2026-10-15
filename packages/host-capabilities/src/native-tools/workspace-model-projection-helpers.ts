import {
  clipGrepProjectionLine,
  decodedTextModelOutputChars,
  normalizeGrepProjectionLine,
  PROJECTION_ENVELOPE_RESERVE_CHARS,
} from '@brainstrike/agent';

export { PROJECTION_ENVELOPE_RESERVE_CHARS };

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

// Delegates to `@brainstrike/agent`'s grep-model-format so this desktop-side
// line normalization/clipping and the durable artifact-search projector
// (packages/agent/src/tool-projection/tool-output-artifact-reader.ts) share one
// implementation instead of independent copies that could silently drift.
export const projectionSingleLine = normalizeGrepProjectionLine;

export function escapeProjectionPathLineBreaks(value: string): string {
  return value
    .replace(/\r/gu, String.raw`\r`)
    .replace(/\n/gu, String.raw`\n`)
    .replace(/\u2028/gu, String.raw`\u2028`)
    .replace(/\u2029/gu, String.raw`\u2029`);
}

export function clipProjectionEnd(value: string, maxChars: number, label: string): string {
  return clipGrepProjectionLine(value, maxChars, label);
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
 * The ONE domain-projection budget ruler (BST-1195), delegating to
 * `@brainstrike/agent`'s `decodedTextModelOutputChars` so this desktop-side
 * math and the runtime's own domain-projection guards
 * (`assertDomainProjectionWithinBudget` /`composeHookContextWithProjection`
 * in `packages/agent/src/tool-projection/tool-model-output.ts`) can never diverge
 * again — PR #2334 review caught exactly that divergence when the two sides
 * held independent copies of this formula. Tokens come from the DECODED
 * string the model actually reads, where a literal newline is ONE character
 * — not from the JSON-serialized `{"type":"text","value":"..."}` envelope,
 * which doubles every newline/quote/backslash. Every domain projector MUST
 * measure fit through this function against
 * MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET; no site-local
 * JSON.stringify(...).length math is allowed. Pass the same `lines` array
 * you would pass to makeWorkspaceTextModelOutput; for a value you already
 * have as a single string (e.g. replaying a stored projection's `value`
 * field), pass it as a one-element array `[value]`.
 */
export function decodedWorkspaceTextModelOutputChars(lines: readonly string[]): number {
  return decodedTextModelOutputChars(lines.join('\n'));
}
