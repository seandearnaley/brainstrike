export interface ToolLineRange {
  endLine: number;
  startLine: number;
}

export interface TapestryLineRange {
  endLine: number;
  startLine: number;
}

export function toolLineRangeToTapestryRange(range: ToolLineRange): TapestryLineRange {
  const startLine = Math.max(0, range.startLine - 1);
  return {
    startLine,
    endLine: Math.max(startLine + 1, range.endLine),
  };
}

export function tapestryLineRangeToToolRange(range: TapestryLineRange): ToolLineRange {
  return {
    startLine: range.startLine + 1,
    endLine: range.endLine,
  };
}
