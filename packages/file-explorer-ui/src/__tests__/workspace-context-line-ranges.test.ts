import { describe, expect, it } from 'vitest';
import {
  tapestryLineRangeToToolRange,
  toolLineRangeToTapestryRange,
} from '../workspace-context-line-ranges';

describe('workspace context line range conversion', () => {
  it('converts 1-indexed inclusive tool lines to 0-indexed exclusive tapestry lines', () => {
    expect(toolLineRangeToTapestryRange({ endLine: 12, startLine: 4 })).toEqual({
      endLine: 12,
      startLine: 3,
    });
  });

  it('keeps single-line tool ranges visible in tapestry coordinates', () => {
    expect(toolLineRangeToTapestryRange({ endLine: 1, startLine: 1 })).toEqual({
      endLine: 1,
      startLine: 0,
    });
  });

  it('converts 0-indexed exclusive tapestry lines back to tool lines', () => {
    expect(tapestryLineRangeToToolRange({ endLine: 12, startLine: 3 })).toEqual({
      endLine: 12,
      startLine: 4,
    });
  });

  it('rejects invalid tool ranges instead of silently clamping', () => {
    expect(() => toolLineRangeToTapestryRange({ endLine: 5, startLine: 10 })).toThrow(RangeError);
    expect(() => toolLineRangeToTapestryRange({ endLine: 1, startLine: 0 })).toThrow(RangeError);
  });

  it('rejects invalid tapestry ranges instead of silently converting them', () => {
    expect(() => tapestryLineRangeToToolRange({ endLine: 5, startLine: 5 })).toThrow(RangeError);
    expect(() => tapestryLineRangeToToolRange({ endLine: 1, startLine: -1 })).toThrow(RangeError);
  });
});
