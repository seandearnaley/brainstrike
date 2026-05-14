import { describe, expect, it } from 'vitest';
import {
  tapestryLineRangeToToolRange,
  toolLineRangeToTapestryRange,
} from '../workspace-context-line-ranges';

describe('workspace context line range conversion', () => {
  it('converts 1-indexed inclusive tool lines to 0-indexed exclusive tapestry lines', () => {
    expect(toolLineRangeToTapestryRange({ startLine: 4, endLine: 12 })).toEqual({
      startLine: 3,
      endLine: 12,
    });
  });

  it('keeps single-line tool ranges visible in tapestry coordinates', () => {
    expect(toolLineRangeToTapestryRange({ startLine: 1, endLine: 1 })).toEqual({
      startLine: 0,
      endLine: 1,
    });
  });

  it('converts 0-indexed exclusive tapestry lines back to tool lines', () => {
    expect(tapestryLineRangeToToolRange({ startLine: 3, endLine: 12 })).toEqual({
      startLine: 4,
      endLine: 12,
    });
  });
});
