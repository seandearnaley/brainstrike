import { screen } from '@testing-library/react';
import { beforeEach, describe, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { createCompositeKey, defaultProps, render, userEvent } from './preview-panel-test-utils';

describe('PreviewPanel - File Type Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show appropriate message for binary files', async () => {
    const selectedFile = createCompositeKey('image.png');
    render(
      <PreviewPanel {...defaultProps} selectedFiles={new Set([selectedFile])} fileContents={{}} />
    );

    const fileCell = screen.getByText('image.png').closest('td');
    if (fileCell) {
      await userEvent.click(fileCell);
    }

    await screen.findByText('No content available');
  });

  it('should show appropriate message for unsupported files', async () => {
    const selectedFile = createCompositeKey('file.xyz');
    render(
      <PreviewPanel {...defaultProps} selectedFiles={new Set([selectedFile])} fileContents={{}} />
    );

    const fileCell = screen.getByText('file.xyz').closest('td');
    if (fileCell) {
      await userEvent.click(fileCell);
    }

    await screen.findByText('No content available');
  });

  it('should handle files with no extension', async () => {
    const selectedFile = createCompositeKey('README');
    const fileContents = { [selectedFile]: 'README content' };
    render(
      <PreviewPanel
        {...defaultProps}
        selectedFiles={new Set([selectedFile])}
        fileContents={fileContents}
      />
    );

    const fileCell = screen.getByText('README').closest('td');
    if (fileCell) {
      await userEvent.click(fileCell);
    }

    await screen.findByText('README content');
  });

  it('should handle files with multiple dots', async () => {
    const selectedFile = createCompositeKey('test.spec.tsx');
    const fileContents = { [selectedFile]: 'Test content' };
    render(
      <PreviewPanel
        {...defaultProps}
        selectedFiles={new Set([selectedFile])}
        fileContents={fileContents}
      />
    );

    const fileCell = screen.getByText('test.spec.tsx').closest('td');
    if (fileCell) {
      await userEvent.click(fileCell);
    }

    await screen.findByText('Test content');
  });
});
