import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { render, uiTestProps, userEvent } from './preview-panel-test-utils';

function makeKey(folder: string, path: string) {
  return `${folder}|@|${path}`;
}

describe('PreviewPanel - Folder Group Expand/Collapse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should toggle folder expansion when clicking the folder header', async () => {
    const file1 = makeKey('folderA', 'a.txt');
    const file2 = makeKey('folderB', 'b.txt');
    const selectedFiles = new Set([file1, file2]);

    render(<PreviewPanel {...uiTestProps} selectedFiles={selectedFiles} fileContents={{}} />);

    const user = userEvent.setup();

    const folderButton = await screen.findByRole('button', { name: /folderA/i });
    expect(folderButton).toHaveAttribute('aria-expanded', 'true');

    await user.click(folderButton);
    expect(folderButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(folderButton);
    expect(folderButton).toHaveAttribute('aria-expanded', 'true');
  });
});
