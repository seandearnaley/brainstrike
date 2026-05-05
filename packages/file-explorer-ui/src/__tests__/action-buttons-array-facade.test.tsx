import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import ActionButtonsArrayFacade from '../action-buttons-array-facade';

describe('ActionButtonsArrayFacade', () => {
  it('converts arrays to Sets and maps Set back to array on change', async () => {
    const user = userEvent.setup();
    const displayed = ['a.ts', 'b.ts'];
    const selected: string[] = [];
    const setSelectedFiles = vi.fn();

    render(
      <ActionButtonsArrayFacade
        currentFolderId={'folder'}
        displayedFiles={displayed}
        encodeFileSelection={(folder, p) => `${folder}:${p}`}
        maxSelectionCount={10}
        selectedFiles={selected}
        setSelectedFiles={setSelectedFiles}
      />
    );

    // Click Select All
    const btn = screen.getByRole('button', { name: /select all/i });
    await user.click(btn);

    expect(setSelectedFiles).toHaveBeenCalledTimes(1);
    const arg = setSelectedFiles.mock.calls[0]?.[0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toEqual(['folder:a.ts', 'folder:b.ts']);
  });
});
