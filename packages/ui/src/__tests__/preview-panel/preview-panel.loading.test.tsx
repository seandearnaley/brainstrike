// All usages of PreviewPanel now use uiTestProps, so type errors for missing required props should be resolved.

import React from 'react';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../../preview-panel';
import { createCompositeKey, defaultProps, render, uiTestProps, userEvent } from './preview-panel-test-utils';

describe('PreviewPanel - Loading States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should show loading state while content is being loaded', () => {
    const selectedFile = createCompositeKey('file1.txt');
    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={new Set([selectedFile])}
        fileContents={{}}
      />
    );

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('should handle multiple files loading simultaneously', () => {
    const selectedFiles = new Set([
      createCompositeKey('file1.txt'),
      createCompositeKey('file2.txt'),
      createCompositeKey('file3.txt'),
    ]);
    const loadingFiles = new Set([
      createCompositeKey('file1.txt'),
      createCompositeKey('file2.txt'),
    ]);

    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={selectedFiles}
        loadingFiles={loadingFiles}
        fileContents={{}}
      />
    );

    const loadingSpinners = screen.getAllByTestId('loading-spinner');
    expect(loadingSpinners).toHaveLength(2);
  });

  it('should show correct loading message for single file', () => {
    const selectedFile = createCompositeKey('file1.txt');
    const loadingFiles = new Set([createCompositeKey('file1.txt')]);

    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={loadingFiles}
        fileContents={{}}
      />
    );

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('should handle loading state transitions', async () => {
    const selectedFile = createCompositeKey('file1.txt');
    const { rerender } = render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={new Set([selectedFile])}
        fileContents={{}}
      />
    );

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

    // Simulate loading completion
    rerender(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={new Set()}
        fileContents={{ [selectedFile]: 'Loaded content' }}
      />
    );

    expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();

    // In the new UI, we need to click on the table cell to expand the file
    const fileCell = screen.getByText('file1.txt').closest('td');
    if (fileCell) {
      await userEvent.click(fileCell);
    }

    // Wait for the content to be rendered
    await screen.findByText('Loaded content');
  });

  it('should handle partial loading states', () => {
    const selectedFiles = new Set([
      createCompositeKey('file1.txt'),
      createCompositeKey('file2.txt'),
    ]);
    const loadingFiles = new Set([createCompositeKey('file1.txt')]);
    const fileContents = { [createCompositeKey('file2.txt')]: 'Content 2' };

    render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={selectedFiles}
        loadingFiles={loadingFiles}
        fileContents={fileContents}
      />
    );

    const loadingSpinners = screen.getAllByTestId('loading-spinner');
    expect(loadingSpinners).toHaveLength(1);
  });

  it('should handle race conditions in loading', async () => {
    const selectedFile = createCompositeKey('file1.txt');
    const { rerender } = render(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={new Set([selectedFile])}
        fileContents={{}}
      />
    );

    // Simulate a race condition where content arrives before loading state updates
    rerender(
      <PreviewPanel
        {...uiTestProps}
        selectedFiles={new Set([selectedFile])}
        loadingFiles={new Set([selectedFile])}
        fileContents={{ [selectedFile]: 'Content arrived early' }}
      />
    );

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });
});
