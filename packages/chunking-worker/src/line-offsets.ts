/**
 * Offset → 1-based line mapping shared by the chunker and the symbol
 * extractor. Lives in its own module because `extract-symbols.ts` and
 * `portable-chunking.ts` both need it and importing either from the other
 * would be a cycle. Implementations moved verbatim from portable-chunking.ts.
 */

export function buildLineStartOffsets(content: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

export function findLineForOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid] ?? 0;
    if (lineStart <= offset) {
      best = mid;
      low = mid + 1;
      continue;
    }
    high = mid - 1;
  }

  return best + 1;
}
