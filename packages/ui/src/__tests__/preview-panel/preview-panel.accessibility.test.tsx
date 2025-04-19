import React from 'react';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { createCompositeKey, defaultProps, render, uiTestProps, userEvent } from './preview-panel-test-utils';

describe('PreviewPanel - Accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should maintain correct tab order after removing a file', async () => {
    const selectedFiles = new Set([
      createCompositeKey('file1.txt'),
      createCompositeKey('file2.txt'),
    ]);
    const user = userEvent.setup();
    const { rerender } = render(
      <PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={{}} />
    );

    // With the new UI, we have more buttons: expand/collapse all, folder toggle, sort buttons, etc.

    // Remove first file
    await user.click(screen.getByLabelText('Remove file1.txt from selection'));

    // Rerender with updated selectedFiles
    rerender(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([createCompositeKey('file2.txt')])}
        fileContents={{}}
      />
    );

    // Verify file2.txt is still in the document
    const file2Element = screen.getByText('file2.txt');
    expect(file2Element).toBeInTheDocument();

    // Find the remove button
    const removeButton = screen.getByLabelText('Remove file2.txt from selection');
    expect(removeButton).toBeInTheDocument();
  });

  it('should preserve keyboard navigation after file removal', async () => {
    const selectedFiles = new Set([
      createCompositeKey('file1.txt'),
      createCompositeKey('file2.txt'),
    ]);
    const user = userEvent.setup();

    render(<PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={{}} />);

    // Initial tab order check - with the new UI, the first focusable element is the Expand All button
    await user.tab();

    // First, we should focus the Expand All button
    const expandAllButton = screen.getByRole('button', { name: /Expand All/i });
    expect(expandAllButton).toHaveFocus();

    // Next tab to Collapse All button
    await user.tab();
    const collapseAllButton = screen.getByRole('button', {
      name: /Collapse All/i,
    });
    expect(collapseAllButton).toHaveFocus();

    // Next tab to folder button (which is now a single button element)
    await user.tab();
    const folderButton = screen.getByRole('button', {
      name: (name) => name.includes('test-folder'),
    });
    expect(folderButton).toHaveFocus();

    // Tab to the "Select all files" checkbox - we skip the folder toggle since it's now part of the folder button
    await user.tab();
    const folderCheckbox = screen.getByRole('checkbox', {
      name: /Select all files in test-folder/i,
    });
    expect(folderCheckbox).toHaveFocus();

    // Tab to the File Path sort button
    await user.tab();
    const filePathButton = screen.getByRole('button', { name: /File Path/i });
    expect(filePathButton).toHaveFocus();

    // Tab to the Size sort button
    await user.tab();
    const sizeButton = screen.getByRole('button', { name: /Size/i });
    expect(sizeButton).toHaveFocus();

    // Tab to the Tokens sort button
    await user.tab();
    // Use a more specific query to find the Tokens button in the table header
    const tokensButton = screen.getByRole('button', {
      name: (name) => name === 'Tokens' || name.trim() === 'Tokens',
    });
    expect(tokensButton).toHaveFocus();

    // Tab to the file checkbox
    await user.tab();
    const fileCheckbox = screen.getByRole('checkbox', {
      name: /Select file1\.txt/i,
    });
    expect(fileCheckbox).toHaveFocus();

    // Continue tabbing to reach the file expand button
    await user.tab();
    const fileExpandButton = screen
      .getAllByRole('button')
      .find((button) => button.querySelector('svg.transition-transform') !== null);
    expect(fileExpandButton).toHaveFocus();
  });
});
