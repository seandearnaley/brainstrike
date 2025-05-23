import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import {
  createCompositeKey,
  mockOnSelectionChange,
  render,
  uiTestProps,
  userEvent,
} from './preview-panel-test-utils';

describe('PreviewPanel - Removal Undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should restore file selection when undo is triggered', async () => {
    const file1 = createCompositeKey('file1.txt');
    const file2 = createCompositeKey('file2.txt');
    const selected = new Set([file1, file2]);

    let capturedUndo: ((key: string, snapshot: Set<string>) => void) | undefined;
    let snapshot: Set<string> | undefined;
    const performUndoableAction = vi.fn((_key, _itemKey, opts) => {
      snapshot = opts.getStateSnapshot();
      capturedUndo = opts.onUndo;
    });

    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={selected}
        fileContents={{}}
        performUndoableAction={performUndoableAction}
      />
    );

    const removeButton = screen.getByLabelText('Remove file1.txt from selection');
    await userEvent.click(removeButton);

    expect(mockOnSelectionChange).toHaveBeenCalledWith(new Set([file2]));

    capturedUndo?.(file1, snapshot as Set<string>);

    const restored = (mockOnSelectionChange.mock.calls[1]?.[0] ?? new Set()) as Set<string>;
    expect(Array.from(restored).sort()).toEqual([file1, file2].sort());
  });
});
