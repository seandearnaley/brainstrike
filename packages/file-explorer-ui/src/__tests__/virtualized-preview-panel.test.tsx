import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { VirtualizedPreviewPanel } from '../virtualized-preview-panel';

const mockDecodeFileSelection = (compositeKey: string) => ({
  folderId: 'test-folder',
  path: compositeKey.replace('test-folder:', ''),
});

const mockCountTokensHeuristic = (content: string) => content.length;

// const mockEstimateTokenCost = (tokens: number) => tokens * 0.00001;

const mockPerformUndoableAction = vi.fn();

const defaultProps = {
  selectedFiles: new Set<string>(),
  fileContents: {},
  loadingFiles: new Set<string>(),
  onSelectionChange: vi.fn(),
  decodeFileSelection: mockDecodeFileSelection,
  countTokensHeuristic: mockCountTokensHeuristic,
  performUndoableAction: mockPerformUndoableAction,
};

describe('VirtualizedPreviewPanel', () => {
  it('renders empty state when no files are selected', () => {
    render(<VirtualizedPreviewPanel {...defaultProps} />);

    expect(screen.getByText('No files selected')).toBeInTheDocument();
  });

  it('renders header with file count when selections are provided', () => {
    const selectedFiles = new Set(['test-folder:file1.txt', 'test-folder:file2.txt']);
    const fileContents = {
      'test-folder:file1.txt': 'Hello world',
      'test-folder:file2.txt': 'Another file',
    };

    render(
      <VirtualizedPreviewPanel
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    // Should show file count in header
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/files/)).toBeInTheDocument();
  });

  it('renders header with token count', () => {
    const selectedFiles = new Set(['test-folder:file1.txt']);
    const fileContents = {
      'test-folder:file1.txt': 'Hello world',
    };

    render(
      <VirtualizedPreviewPanel
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    // Should show token count in header
    expect(screen.getByText(/tokens/)).toBeInTheDocument();
  });
});
