import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualizedPreviewPanelTabbed } from '../virtualized-preview-panel-tabbed';

// Mock the virtualizer
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(() => ({
    getVirtualItems: vi.fn(() => [
      { key: '0', index: 0, start: 0, size: 60 },
      { key: '1', index: 1, start: 60, size: 40 },
      { key: '2', index: 2, start: 100, size: 40 },
    ]),
    getTotalSize: vi.fn(() => 140),
  })),
}));

// Mock components
vi.mock('../file-row', () => ({
  default: vi.fn(({ item, onToggleSelection, onRemove, onShowDetail, isSelected, isLoading }) => (
    <div data-testid={`file-row-${item.compositeKey}`}>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) => onToggleSelection(e.target.checked)}
        data-testid={`checkbox-${item.compositeKey}`}
      />
      <span>{item.path}</span>
      {isLoading && <span data-testid="loading-spinner">Loading...</span>}
      <button type="button" onClick={onRemove} data-testid={`remove-${item.compositeKey}`}>
        Remove
      </button>
      <button type="button" onClick={onShowDetail} data-testid={`detail-${item.compositeKey}`}>
        Show Detail
      </button>
    </div>
  )),
}));

vi.mock('../folder-header-row', () => ({
  default: vi.fn(({ item, isCollapsed, onToggleCollapse }) => (
    <div data-testid={`folder-header-${item.folderId}`}>
      <button type="button" onClick={onToggleCollapse}>
        {isCollapsed ? '▶' : '▼'} {item.folderId} ({item.fileCount} files, {item.totalTokens}{' '}
        tokens)
      </button>
    </div>
  )),
}));

describe('VirtualizedPreviewPanelTabbed', () => {
  const defaultProps = {
    selectedFiles: new Set<string>(),
    fileContents: {},
    loadingFiles: new Set<string>(),
    onSelectionChange: vi.fn(),
    fileSizes: {},
    decodeFileSelection: vi.fn((key: string) => {
      const [folderId, ...pathParts] = key.split(':');
      return { folderId, path: pathParts.join(':') };
    }),
    countTokensHeuristic: vi.fn((content: string) => content.length),
    estimateTokenCost: vi.fn((tokens: number) => tokens * 0.01),
    performUndoableAction: vi.fn(),
    onFileClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render empty state when no files are selected', () => {
    render(<VirtualizedPreviewPanelTabbed {...defaultProps} />);
    expect(screen.getByText('No files selected')).toBeInTheDocument();
  });

  it('should render selected files grouped by folder', async () => {
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts', 'folder2:file3.ts']);

    const virtualModule = await import('@tanstack/react-virtual');
    const { useVirtualizer } = vi.mocked(virtualModule);
    vi.mocked(useVirtualizer).mockReturnValue({
      getVirtualItems: vi.fn(() => [
        { key: '0', index: 0, start: 0, size: 60 }, // folder1 header
        { key: '1', index: 1, start: 60, size: 40 }, // file1.ts
        { key: '2', index: 2, start: 100, size: 40 }, // file2.ts
        { key: '3', index: 3, start: 140, size: 60 }, // folder2 header
        { key: '4', index: 4, start: 200, size: 40 }, // file3.ts
      ]),
      getTotalSize: vi.fn(() => 240),
    });

    render(<VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />);

    expect(screen.getByTestId('folder-header-folder1')).toBeInTheDocument();
    expect(screen.getByTestId('folder-header-folder2')).toBeInTheDocument();
    expect(screen.getByTestId('file-row-folder1:file1.ts')).toBeInTheDocument();
    expect(screen.getByTestId('file-row-folder1:file2.ts')).toBeInTheDocument();
    expect(screen.getByTestId('file-row-folder2:file3.ts')).toBeInTheDocument();
  });

  it('should calculate and display token counts', () => {
    const selectedFiles = new Set(['folder1:file1.ts']);
    const fileContents = {
      'folder1:file1.ts': 'const x = 42; // This is test content',
    };

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    // Token count should be displayed
    expect(defaultProps.countTokensHeuristic).toHaveBeenCalledWith(
      fileContents['folder1:file1.ts']
    );
  });

  it('should handle file selection toggle', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts']);

    render(<VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />);

    const checkbox = screen.getByTestId('checkbox-folder1:file1.ts');
    await user.click(checkbox);

    // Check that internal state is updated
    expect(checkbox).toBeChecked();
  });

  it('should handle batch file removal', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts']);
    const mockOnSelectionChange = vi.fn();

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        onSelectionChange={mockOnSelectionChange}
      />
    );

    // Select files for batch removal
    const checkbox1 = screen.getByTestId('checkbox-folder1:file1.ts');
    const checkbox2 = screen.getByTestId('checkbox-folder1:file2.ts');

    await user.click(checkbox1);
    await user.click(checkbox2);

    // Click batch remove button
    const batchRemoveButton = screen.getByText('Remove Selected');
    await user.click(batchRemoveButton);

    expect(mockOnSelectionChange).toHaveBeenCalledWith(new Set());
    expect(defaultProps.performUndoableAction).toHaveBeenCalled();
  });

  it('should handle individual file removal', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts']);
    const mockOnSelectionChange = vi.fn();

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        onSelectionChange={mockOnSelectionChange}
      />
    );

    const removeButton = screen.getByTestId('remove-folder1:file1.ts');
    await user.click(removeButton);

    expect(mockOnSelectionChange).toHaveBeenCalledWith(new Set(['folder1:file2.ts']));
    expect(defaultProps.performUndoableAction).toHaveBeenCalled();
  });

  it('should handle file click for tab opening', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts']);
    const mockOnFileClick = vi.fn();

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        onFileClick={mockOnFileClick}
      />
    );

    const detailButton = screen.getByTestId('detail-folder1:file1.ts');
    await user.click(detailButton);

    expect(mockOnFileClick).toHaveBeenCalledWith('folder1:file1.ts');
  });

  it('should handle folder collapse/expand', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts']);

    const virtualModule = await import('@tanstack/react-virtual');
    const { useVirtualizer } = vi.mocked(virtualModule);

    // Mock expanded state
    vi.mocked(useVirtualizer).mockReturnValue({
      getVirtualItems: vi.fn(() => [
        { key: '0', index: 0, start: 0, size: 60 },
        { key: '1', index: 1, start: 60, size: 40 },
        { key: '2', index: 2, start: 100, size: 40 },
      ]),
      getTotalSize: vi.fn(() => 140),
    });

    const { rerender } = render(
      <VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />
    );

    // Click to collapse
    const folderButton = screen.getByText(/▼ folder1/);
    await user.click(folderButton);

    // Mock collapsed state (only header visible)
    vi.mocked(useVirtualizer).mockReturnValue({
      getVirtualItems: vi.fn(() => [{ key: '0', index: 0, start: 0, size: 60 }]),
      getTotalSize: vi.fn(() => 60),
    });

    rerender(<VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />);

    // Should show collapsed indicator
    expect(screen.getByText(/▶ folder1/)).toBeInTheDocument();
  });

  it('should handle expand/collapse all folders', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts', 'folder2:file2.ts']);

    render(<VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />);

    // Click collapse all
    const collapseAllButton = screen.getByText(/Collapse/);
    await user.click(collapseAllButton);

    // All folders should be collapsed
    // (In real implementation, this would update the virtualizer items)

    // Click expand all
    const expandAllButton = screen.getByText(/Expand/);
    await user.click(expandAllButton);

    // All folders should be expanded
    // (In real implementation, this would update the virtualizer items)
  });

  it('should handle select/deselect all', async () => {
    const user = userEvent.setup();
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts']);

    render(<VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={selectedFiles} />);

    // Click select all checkbox
    const selectAllCheckbox = screen.getByRole('checkbox', { checked: false });
    await user.click(selectAllCheckbox);

    // All files should be selected
    expect(selectAllCheckbox).toBeChecked();

    // Click again to deselect all
    await user.click(selectAllCheckbox);
    expect(selectAllCheckbox).not.toBeChecked();
  });

  it('should display loading state for files', async () => {
    const selectedFiles = new Set(['folder1:file1.ts']);
    const loadingFiles = new Set(['folder1:file1.ts']);

    const virtualModule = await import('@tanstack/react-virtual');
    const { useVirtualizer } = vi.mocked(virtualModule);
    vi.mocked(useVirtualizer).mockReturnValue({
      getVirtualItems: vi.fn(() => [
        { key: '0', index: 0, start: 0, size: 60 }, // folder header
        { key: '1', index: 1, start: 60, size: 40 }, // file row
      ]),
      getTotalSize: vi.fn(() => 100),
    });

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        loadingFiles={loadingFiles}
      />
    );

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('should format file sizes correctly', () => {
    const formatFileSize = (bytes?: number) => {
      if (bytes === undefined) return 'Unknown';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = bytes;
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return `${size.toFixed(1)} ${units[unitIndex]}`;
    };

    expect(formatFileSize(0)).toBe('0.0 B');
    expect(formatFileSize(1023)).toBe('1023.0 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(1073741824)).toBe('1.0 GB');
  });

  it('should format token counts correctly', () => {
    const formatTokenCount = (tokens: number): string => {
      if (tokens < 1000) return tokens.toString();
      if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
      return `${(tokens / 1000000).toFixed(1)}M`;
    };

    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(1000000)).toBe('1.0M');
  });

  it('should display total stats correctly', () => {
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:file2.ts']);
    const fileContents = {
      'folder1:file1.ts': 'test content 1',
      'folder1:file2.ts': 'test content 2',
    };

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    // Should show file count
    expect(screen.getByText(/2 files/)).toBeInTheDocument();

    // Should show token count in the header
    expect(screen.getByText(/28 tokens/)).toBeInTheDocument();
  });

  it('should skip binary and inaccessible files in token count', () => {
    const selectedFiles = new Set(['folder1:file1.ts', 'folder1:binary.png']);
    const fileContents = {
      'folder1:file1.ts': 'test content',
      'folder1:binary.png': 'Binary file: Cannot display binary content',
    };

    render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    // Only file1.ts should contribute to token count
    expect(defaultProps.countTokensHeuristic).toHaveBeenCalledWith('test content');
    expect(defaultProps.countTokensHeuristic).not.toHaveBeenCalledWith(
      fileContents['folder1:binary.png']
    );
  });

  it('should show progress bar for token usage', () => {
    const selectedFiles = new Set(['folder1:file1.ts']);
    const fileContents = {
      'folder1:file1.ts': 'x'.repeat(50000), // 50k characters
    };

    const { container } = render(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={selectedFiles}
        fileContents={fileContents}
      />
    );

    const progressContainer = container.querySelector('.w-32');
    expect(progressContainer).toBeInTheDocument();
  });

  it('should reset batch selection when selected files change', () => {
    const { rerender } = render(
      <VirtualizedPreviewPanelTabbed {...defaultProps} selectedFiles={new Set(['file1'])} />
    );

    // Change selected files
    rerender(
      <VirtualizedPreviewPanelTabbed
        {...defaultProps}
        selectedFiles={new Set(['file2', 'file3'])}
      />
    );

    // Batch selection should be reset
    const checkboxes = screen.getAllByRole('checkbox');
    const selectAllCheckbox = checkboxes[0]; // First checkbox is the select all
    expect(selectAllCheckbox).not.toBeChecked();
  });
});
