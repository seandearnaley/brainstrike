export interface ToolLineRange {
  endLine: number;
  startLine: number;
}

/** Tapestry ranges are 0-indexed half-open intervals: [startLine, endLine). */
export interface TapestryLineRange {
  endLine: number;
  startLine: number;
}

function assertIntegerLineRange(range: ToolLineRange | TapestryLineRange): void {
  if (!(Number.isInteger(range.startLine) && Number.isInteger(range.endLine))) {
    throw new RangeError('Line ranges must use integer boundaries');
  }
}

export function toolLineRangeToTapestryRange(range: ToolLineRange): TapestryLineRange {
  assertIntegerLineRange(range);
  if (range.startLine < 1 || range.endLine < range.startLine) {
    throw new RangeError('Tool line ranges must be 1-indexed inclusive ranges');
  }

  const startLine = range.startLine - 1;
  return {
    startLine,
    endLine: range.endLine,
  };
}

export function tapestryLineRangeToToolRange(range: TapestryLineRange): ToolLineRange {
  assertIntegerLineRange(range);
  if (range.startLine < 0 || range.endLine <= range.startLine) {
    throw new RangeError('Tapestry line ranges must be 0-indexed exclusive ranges');
  }

  return {
    startLine: range.startLine + 1,
    endLine: range.endLine,
  };
}
