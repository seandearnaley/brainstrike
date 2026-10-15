import { formatGrepProjectionPageRange } from '@brainstrike/assistant-contract/context-provenance';

// The page range has one owner beside its parser: the thread context map reads
// a delivered grep page back from this header (ADR-0021).
export { formatGrepProjectionPageRange };

export function formatGrepContentHeader(args: {
  readonly kept: number;
  readonly lowerBound: boolean;
  readonly offset: number;
  readonly total: number;
}): string {
  return `grep content ${formatGrepProjectionPageRange(args)}`;
}

export function formatGrepContentRow(line: number, text: string, isMatch = true): string {
  return `  ${line}${isMatch ? ':' : '-'} ${text}`;
}

/** One shared home for a matched/context line's rendered length across every
 * grep-shaped projector (workspace grep, artifact search). */
export const GREP_MATCH_LINE_MAX_CHARS = 600;

export function normalizeGrepProjectionLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Collapse a matched/context line to one line and clip it to `maxChars`,
 * appending an explicit "N `label` chars omitted" marker rather than
 * silently truncating. Shared by every grep-shaped projector so the two
 * surfaces (workspace grep, durable artifact search) cannot silently drift
 * on line width or ellipsis wording.
 */
export function clipGrepProjectionLine(
  value: string,
  maxChars: number = GREP_MATCH_LINE_MAX_CHARS,
  label = 'line'
): string {
  const normalized = normalizeGrepProjectionLine(value);
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxChars) {
    return normalized;
  }
  return `${codePoints.slice(0, maxChars).join('')}…[${
    codePoints.length - maxChars
  } ${label} chars omitted]`;
}
