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

export function serializedWorkspaceTextModelOutputChars(lines: readonly string[]): number {
  return JSON.stringify(makeWorkspaceTextModelOutput(lines)).length;
}
