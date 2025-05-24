import '@testing-library/jest-dom';
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { render, uiTestProps, userEvent } from './preview-panel-test-utils';

function makeKey(folder: string, path: string) {
  return `${folder}|@|${path}`;
}

describe('PreviewPanel - Sorting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should sort files by path and tokens when sort buttons are clicked', async () => {
    const fileA = makeKey('folder1', 'a.txt');
    const fileB = makeKey('folder1', 'b.txt');
    const fileC = makeKey('folder1', 'c.txt');

    const selectedFiles = new Set([fileA, fileB, fileC]);

    const fileContents = {
      [fileA]: 'aaa',
      [fileB]: 'b',
      [fileC]: 'cc',
    };

    render(
      <PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={fileContents} />
    );

    const user = userEvent.setup();

    const expandAllButton = screen.getByText('Expand All');
    await user.click(expandAllButton);

    const table = screen.getByRole('table');
    const getOrder = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getByText(/\.txt$/).textContent);

    expect(getOrder()).toEqual(['a.txt', 'b.txt', 'c.txt']);

    const pathButton = screen.getByText('File Path');
    await user.click(pathButton);
    expect(getOrder()).toEqual(['c.txt', 'b.txt', 'a.txt']);

    const tokensButton = screen.getByText('Tokens');
    await user.click(tokensButton);
    expect(getOrder()).toEqual(['a.txt', 'c.txt', 'b.txt']);
  });
});
