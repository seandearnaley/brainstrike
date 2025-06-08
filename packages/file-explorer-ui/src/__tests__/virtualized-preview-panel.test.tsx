import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { VirtualizedPreviewPanel } from '../virtualized-preview-panel';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }) => {
    return {
      getTotalSize: () => count * 50,
      getVirtualItems: () =>
        Array.from({ length: count }).map((_, index) => ({
          key: index,
          index,
          size: 50,
          start: index * 50,
        })),
    };
  }),
}));

const mockDecodeFileSelection = (compositeKey: string): { folderId: string; path: string } => {
  const [folderId = '', path = ''] = compositeKey.split(':');
  return { folderId, path };
};

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
    expect(screen.getAllByText(/files/).length).toBeGreaterThan(0);
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

  it('toggles folder collapse and expand', async () => {
    const selectedFiles = new Set(['folderA:file1.txt', 'folderB:file2.txt']);

    render(
      <VirtualizedPreviewPanel {...defaultProps} selectedFiles={selectedFiles} fileContents={{}} />
    );

    const user = userEvent.setup();

    // folderA initially expanded so its file should be present
    expect(screen.getByText('file1.txt')).toBeInTheDocument();

    const folderButton = screen.getByRole('button', { name: /folderA/i });
    await user.click(folderButton);

    expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();

    await user.click(folderButton);

    expect(screen.getByText('file1.txt')).toBeInTheDocument();
  });

  it('expands and collapses all folders', async () => {
    const selectedFiles = new Set(['folderA:a.txt', 'folderB:b.txt']);

    render(
      <VirtualizedPreviewPanel {...defaultProps} selectedFiles={selectedFiles} fileContents={{}} />
    );

    const user = userEvent.setup();

    // Collapse all
    await user.click(screen.getByRole('button', { name: /Collapse/i }));
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();
    expect(screen.queryByText('b.txt')).not.toBeInTheDocument();

    // Expand all
    await user.click(screen.getByRole('button', { name: /Expand/i }));
    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('b.txt')).toBeInTheDocument();
  });

  it('handles batch selection and removal with undo', async () => {
    const selectedFiles = new Set(['folderA:a.txt', 'folderA:b.txt']);

    const onSelectionChange = vi.fn();
    const performUndoableAction = vi.fn();

    render(
      <VirtualizedPreviewPanel
        {...defaultProps}
        selectedFiles={selectedFiles}
        onSelectionChange={onSelectionChange}
        performUndoableAction={performUndoableAction}
        fileContents={{}}
      />
    );

    const user = userEvent.setup();

    // select both files via checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    const first = checkboxes[1];
    const second = checkboxes[2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await user.click(first as Element);
    await user.click(second as Element);

    // batch bar should show
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remove Selected/i }));

    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
    expect(performUndoableAction).toHaveBeenCalledWith(
      'batch-remove',
      'batch-remove',
      expect.objectContaining({ actionName: 'Files removed' })
    );
  });

  it('removes an individual file with undo', async () => {
    const selectedFiles = new Set(['folderA:a.txt']);

    const onSelectionChange = vi.fn();
    const performUndoableAction = vi.fn();

    render(
      <VirtualizedPreviewPanel
        {...defaultProps}
        selectedFiles={selectedFiles}
        onSelectionChange={onSelectionChange}
        performUndoableAction={performUndoableAction}
        fileContents={{}}
      />
    );

    const user = userEvent.setup();

    await user.click(screen.getByTitle('Remove from selection'));

    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
    expect(performUndoableAction).toHaveBeenCalledWith(
      'folderA:a.txt',
      'folderA:a.txt',
      expect.objectContaining({ actionName: 'File removed' })
    );
  });

  it('opens and closes the detail panel', async () => {
    const selectedFiles = new Set(['folderA:a.txt']);
    const fileContents = { 'folderA:a.txt': 'content' };

    render(
      <VirtualizedPreviewPanel
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    const user = userEvent.setup();

    await user.click(screen.getByText('a.txt'));
    expect(screen.getByText('content')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close file detail panel' }));
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('uses virtualizer values for container height', () => {
    const selectedFiles = new Set(['folderA:a.txt', 'folderA:b.txt']);

    const { container } = render(
      <VirtualizedPreviewPanel {...defaultProps} selectedFiles={selectedFiles} fileContents={{}} />
    );

    const innerContainer = container.querySelector(
      "div[style*='position: relative']"
    ) as HTMLElement | null;
    expect(innerContainer).not.toBeNull();
    expect(innerContainer).toHaveStyle({ height: '150px' });
  });
});
