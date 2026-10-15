/**
 * "Changed since read" for the thread context map (ADR-0021, BST-2017): the
 * lines a call delivered against the file's current text from the explorer's
 * shared content owner. Only spans that kept their delivered lines (reads and
 * grep hits) can be checked; everything else, and any span whose file text is
 * unavailable, is `unknown`, never "unchanged".
 */
import type { ContextSpan } from '@brainstrike/assistant-ui/thread-context-fold';
import { INACCESSIBLE_CONTENT_PREFIX } from '@brainstrike/file-explorer-hooks';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';

export type SpanFreshness = 'changed' | 'unchanged' | 'unknown';

/** File text the comparison can trust: not a binary or inaccessible placeholder. */
export function isComparableFileText(text: string | undefined): text is string {
  return (
    text !== undefined &&
    text !== BINARY_CONTENT_MESSAGE &&
    !text.startsWith(INACCESSIBLE_CONTENT_PREFIX)
  );
}

export function splitFileLines(text: string): readonly string[] {
  return text.split(/\r?\n/u);
}

export function spanFreshness(
  span: ContextSpan,
  currentLines: readonly string[] | undefined
): SpanFreshness {
  const delivered = span.deliveredLines;
  if (
    currentLines === undefined ||
    delivered === undefined ||
    delivered.length === 0 ||
    span.startLine === undefined ||
    span.repeat === true
  ) {
    return 'unknown';
  }
  const offset = span.startLine - 1;
  for (const [index, line] of delivered.entries()) {
    const current = currentLines[offset + index];
    if (current === undefined || current !== line.replace(/\r$/u, '')) {
      return 'changed';
    }
  }
  return 'unchanged';
}
