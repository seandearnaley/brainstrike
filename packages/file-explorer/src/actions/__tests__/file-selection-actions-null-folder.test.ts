import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileSelectionActions } from '../file-selection-actions';
import { consoleSpy, mockSet } from './file-selection-actions-test-support';

describe('file-selection-actions null folderId early returns', () => {
  beforeEach(() => {
    mockSet.mockClear();
    consoleSpy.mockClear();
  });

  it('addSelectedFile should return early when folderId is null', () => {
    const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

    fileSelectionActions.addSelectedFile(null, 'file.ts');

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('removeSelectedFile should return early when folderId is null', () => {
    const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

    fileSelectionActions.removeSelectedFile(null, 'file.ts');

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('toggleSelectedFile should return early when folderId is null', () => {
    const fileSelectionActions = createFileSelectionActions(mockSet, vi.fn());

    fileSelectionActions.toggleSelectedFile(null, 'file.ts');

    expect(mockSet).not.toHaveBeenCalled();
  });
});
