import { describe, expect, it } from 'vitest';
import {
  CHANGED_FILE_STATUS_PRESENTATION,
  gitStatusPresentation,
} from '../git-status-presentation';

describe('accessible git status presentation', () => {
  it.each([
    ['A', 'Added file', 'text-success'],
    ['D', 'Deleted file', 'text-destructive'],
    ['M', 'Modified file', 'text-warning'],
    ['R', 'Renamed file', 'text-info'],
    ['C', 'Copied file', 'text-info'],
    ['U', 'Unmerged file', 'text-warning'],
    ['T', 'File type changed', 'text-warning'],
    ['?', 'Untracked file', 'text-success'],
  ])('names %s without relying on its color or single letter', (glyph, label, className) => {
    expect(gitStatusPresentation(glyph)).toEqual({ className, glyph, label });
  });

  it('keeps unknown porcelain values explicit instead of inventing a known status', () => {
    expect(gitStatusPresentation('X').label).toBe('Git status X');
    expect(gitStatusPresentation('').label).toBe('Unknown Git status');
  });

  it('covers every Changes tree status with the same named presentation', () => {
    for (const status of ['added', 'deleted', 'modified', 'renamed', 'untracked'] as const) {
      const presentation = CHANGED_FILE_STATUS_PRESENTATION[status];
      expect(presentation).toEqual(gitStatusPresentation(presentation.glyph));
    }
  });
});
