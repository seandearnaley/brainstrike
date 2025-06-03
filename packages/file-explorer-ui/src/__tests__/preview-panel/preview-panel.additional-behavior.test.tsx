import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { createCompositeKey, render, uiTestProps, userEvent } from './preview-panel-test-utils';

function makeKey(folder: string, path: string) {
  return `${folder}|@|${path}`;
}

// Tests covering miscellaneous behaviors of PreviewPanel

describe('PreviewPanel - Additional Behaviors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should calculate tooltip cost using estimateTokenCost', async () => {
    const file = createCompositeKey('file.txt');
    const selectedFiles = new Set([file]);
    const fileContents = { [file]: '12345' }; // 5 tokens with default heuristic

    const estimateTokenCost = vi.fn((tokens: number) => tokens * 0.001);

    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
        estimateTokenCost={estimateTokenCost}
      />
    );

    const user = userEvent.setup();

    await user.click(screen.getByLabelText('Select file.txt'));

    const badge = await screen.findByText(
      (_, element) => element?.getAttribute('title')?.startsWith('Selected: 5 tokens') ?? false
    );
    expect(badge).toHaveAttribute(
      'title',
      'Selected: 5 tokens\nWill save: 5 tokens\nEst. cost saving: $0.0050'
    );
    expect(estimateTokenCost).toHaveBeenCalledWith(5);
  });

  it('should toggle all file selections within a folder', async () => {
    const fileA = makeKey('folder', 'a.txt');
    const fileB = makeKey('folder', 'b.txt');
    const selected = new Set([fileA, fileB]);
    const fileContents = { [fileA]: 'aaa', [fileB]: 'bbb' };

    render(<PreviewPanel {...uiTestProps} selectedFiles={selected} fileContents={fileContents} />);

    const user = userEvent.setup();

    const expandAllButton = screen.getByText('Expand All');
    await user.click(expandAllButton);

    const folderCheckbox = screen.getByLabelText('Select all files in folder');
    await user.click(folderCheckbox);
    expect(screen.getByLabelText('Select a.txt')).toBeChecked();
    expect(screen.getByLabelText('Select b.txt')).toBeChecked();

    await user.click(folderCheckbox);
    expect(screen.getByLabelText('Select a.txt')).not.toBeChecked();
    expect(screen.getByLabelText('Select b.txt')).not.toBeChecked();
  });

  it('should display "N/A" when token count is undefined', async () => {
    const file = makeKey('folder', 'unknown.txt');
    const selectedFiles = new Set([file]);

    render(<PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={{}} />);

    const user = userEvent.setup();
    const expandAllButton = screen.getByText('Expand All');
    await user.click(expandAllButton);

    const tokenCell = screen.getByText('N/A');
    expect(tokenCell).toBeInTheDocument();
  });

  it('should render long file content inside a scrollable container', async () => {
    const file = makeKey('folder', 'long.txt');
    const selectedFiles = new Set([file]);
    const longContent = 'A'.repeat(2000);
    const fileContents = { [file]: longContent };

    render(
      <PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={fileContents} />
    );

    const user = userEvent.setup();
    const expandAllButton = screen.getByText('Expand All');
    await user.click(expandAllButton);
    const fileCell = screen.getByText('long.txt');
    await user.click(fileCell);

    const pre = screen.getByText(longContent);
    const scrollContainer = pre.closest('.preview-panel-scrollbar');
    expect(scrollContainer).toBeInTheDocument();
  });
});
