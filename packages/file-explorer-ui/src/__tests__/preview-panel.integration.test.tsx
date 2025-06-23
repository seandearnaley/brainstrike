import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview-panel';

// Mock the use-preview-panel-state module with realistic implementation
vi.mock('../use-preview-panel-state', () => ({
  usePreviewPanelState: vi.fn(),
  formatTokenCount: (tokens: number) => {
    if (tokens < 1000) return tokens.toString();
    if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}K`;
    return `${(tokens / 1000000).toFixed(1)}M`;
  },
}));

const mockUsePreviewPanelState = vi.mocked(
  await import('../use-preview-panel-state')
).usePreviewPanelState;

// Mock UI component types
interface MockBadgeProps {
  children: React.ReactNode;
  [key: string]: unknown;
}

interface MockButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  [key: string]: unknown;
}

interface MockCheckboxProps {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  [key: string]: unknown;
}

interface MockProgressProps {
  value?: number;
  [key: string]: unknown;
}

// Mock UI components with more realistic behavior
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children, ...props }: MockBadgeProps) => (
    <div data-testid="badge" {...props}>
      {children}
    </div>
  ),
  Button: ({ children, onClick, disabled, ...props }: MockButtonProps) => (
    <button onClick={onClick} disabled={disabled} data-testid="button" {...props}>
      {children}
    </button>
  ),
  Checkbox: ({ checked, onCheckedChange, ...props }: MockCheckboxProps) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      data-testid="checkbox"
      {...props}
    />
  ),
  Progress: ({ value, ...props }: MockProgressProps) => (
    <div data-testid="progress" data-value={value} {...props} />
  ),
}));

// Mock Lucide icons
vi.mock('lucide-react', () => ({
  ArrowDown: () => <div data-testid="arrow-down" />,
  ArrowUp: () => <div data-testid="arrow-up" />,
  FileX2: () => <div data-testid="file-x2" />,
  FolderOpen: () => <div data-testid="folder-open" />,
}));

describe('PreviewPanel Integration Tests', () => {
  const createMockProps = (fileCount = 100) => ({
    selectedFiles: new Set(Array.from({ length: fileCount }, (_, i) => `file${i}`)),
    fileContents: Object.fromEntries(
      Array.from({ length: fileCount }, (_, i) => [`file${i}`, `content of file ${i}`.repeat(10)])
    ),
    loadingFiles: new Set<string>(),
    onSelectionChange: vi.fn(),
    fileSizes: Object.fromEntries(
      Array.from({ length: fileCount }, (_, i) => [`file${i}`, 1024 + i * 100])
    ),
    decodeFileSelection: vi.fn((key: string) => ({
      folderId: `folder-${Math.floor(Number.parseInt(key.replace('file', '')) / 10)}`,
      path: `path/to/folder${Math.floor(Number.parseInt(key.replace('file', '')) / 10)}/${key}.txt`,
    })),
    countTokensHeuristic: vi.fn((content: string) => content.length * 4),
    estimateTokenCost: vi.fn((tokens: number) => tokens * 0.001),
    performUndoableAction: vi.fn(),
    onFileClick: vi.fn(),
  });

  const createMockState = (fileCount = 100) => ({
    batchSelectedFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    totalStats: {
      totalFiles: fileCount,
      totalTokens: fileCount * 200, // Realistic token count
    },
    expandAllFolders: vi.fn(),
    collapseAllFolders: vi.fn(),
    handleRemoveFile: vi.fn(),
    handleBatchRemove: vi.fn(),
    toggleFileSelection: vi.fn(),
    toggleFolderCollapse: vi.fn(),
    handleSelectAll: vi.fn(),
    handleDeselectAll: vi.fn(),
    isAllFilesSelected: false,
    formatFileSize: vi.fn((bytes?: number) => {
      if (bytes === undefined) return 'Unknown';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return `${size.toFixed(1)} ${units[unitIndex]}`;
    }),
    loadingFiles: new Set<string>(),
    flatListItems: Array.from({ length: fileCount }, (_, i) => ({
      type: 'file' as const,
      compositeKey: `file${i}`,
      folderId: `folder-${Math.floor(i / 10)}`,
      path: `path/to/folder${Math.floor(i / 10)}/file${i}.txt`,
      size: 1024 + i * 100,
      tokens: 200 + i * 5,
    })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Complete File Explorer Workflow', () => {
    it('should handle complete file selection and removal workflow', async () => {
      const mockProps = createMockProps(25);
      const mockState = createMockState(25);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Verify initial state
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '25 files | 5,000 tokens';
        })
      ).toBeInTheDocument();

      // Select multiple files
      const checkboxes = screen.getAllByTestId('checkbox');
      expect(checkboxes[1]).toBeInTheDocument();
      expect(checkboxes[2]).toBeInTheDocument();
      expect(checkboxes[3]).toBeInTheDocument();
      fireEvent.click(checkboxes[1]); // Select first file
      fireEvent.click(checkboxes[2]); // Select second file
      fireEvent.click(checkboxes[3]); // Select third file

      // Verify selection UI appears
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Perform batch removal
      const removeButton = screen.getByText('Remove Selected from Project');
      fireEvent.click(removeButton);

      // Verify removal actions were called
      expect(mockProps.performUndoableAction).toHaveBeenCalledWith(
        'batch-remove',
        'batch-remove',
        expect.objectContaining({
          actionName: 'Files removed',
          itemDescription: expect.stringContaining('files from selection'),
        })
      );
      expect(mockProps.onSelectionChange).toHaveBeenCalled();
    });

    it('should handle sorting and pagination together', () => {
      const mockProps = createMockProps(120);
      const mockState = createMockState(120);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Verify pagination is shown
      expect(screen.getByText('Page 1 of 3 (120 total files)')).toBeInTheDocument();

      // Sort by file path
      const pathHeader = screen.getByText('File Path');
      fireEvent.click(pathHeader);

      // Verify sort indicator appears somewhere after clicking
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);

      // Navigate to next page
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      expect(screen.getByText('Page 2 of 3 (120 total files)')).toBeInTheDocument();

      // Change sort direction
      fireEvent.click(pathHeader);
      expect(screen.getAllByTestId('arrow-down').length).toBeGreaterThan(0);

      // Reset sort should go back to page 1
      const resetButton = screen.getByText('Reset Sort');
      fireEvent.click(resetButton);

      expect(screen.getByText('Page 1 of 3 (120 total files)')).toBeInTheDocument();
    });

    it('should handle folder operations with large datasets', () => {
      const mockProps = createMockProps(200);
      const mockState = createMockState(200);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Expand all folders
      const expandButton = screen.getByTitle('Expand all folders');
      fireEvent.click(expandButton);
      expect(mockState.expandAllFolders).toHaveBeenCalled();

      // Collapse all folders
      const collapseButton = screen.getByTitle('Collapse all folders');
      fireEvent.click(collapseButton);
      expect(mockState.collapseAllFolders).toHaveBeenCalled();

      // Select all files globally
      const selectAllButton = screen.getByText(/Select All \(200\)/);
      fireEvent.click(selectAllButton);

      // Should be disabled after selection
      expect(selectAllButton).toBeDisabled();
    });
  });

  describe('Performance with Large Datasets', () => {
    it('should render large datasets efficiently', () => {
      const mockProps = createMockProps(1000);
      const mockState = createMockState(1000);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      const startTime = performance.now();
      render(<PreviewPanel {...mockProps} />);
      const endTime = performance.now();

      // Should render within reasonable time
      expect(endTime - startTime).toBeLessThan(200);

      // Should show pagination for large datasets
      expect(screen.getByText('Page 1 of 20 (1000 total files)')).toBeInTheDocument();

      // Should only render first page items (performance optimization)
      expect(screen.getByText('file0.txt')).toBeInTheDocument();
      expect(screen.queryByText('file60.txt')).not.toBeInTheDocument(); // Beyond first page
    });

    it('should handle rapid pagination without performance issues', () => {
      const mockProps = createMockProps(500);
      const mockState = createMockState(500);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      const startTime = performance.now();

      // Rapidly navigate through pages
      const nextButton = screen.getByText('Next');
      for (let i = 0; i < 5; i++) {
        fireEvent.click(nextButton);
      }

      const endTime = performance.now();

      // Should handle rapid navigation efficiently (allow a bit more time for CI)
      expect(endTime - startTime).toBeLessThan(150);
      expect(screen.getByText('Page 6 of 10 (500 total files)')).toBeInTheDocument();
    });
  });

  describe('Error Recovery and Edge Cases', () => {
    it('should handle mixed loading and error states', () => {
      const mockProps = createMockProps(50);
      mockProps.loadingFiles = new Set(['file1', 'file2']);
      mockProps.fileContents = {
        ...mockProps.fileContents,
        file3: 'File not accessible: Permission denied',
        file4: 'Binary file detected',
      };

      const mockState = createMockState(50);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Should still render successfully with mixed states
      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '50 files | 10,000 tokens';
        })
      ).toBeInTheDocument();
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });

    it('should handle dynamic file set changes', async () => {
      const mockProps = createMockProps(10);
      const mockState = createMockState(10);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      const { rerender } = render(<PreviewPanel {...mockProps} />);

      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '10 files | 2,000 tokens';
        })
      ).toBeInTheDocument();

      // Simulate adding more files
      const newMockProps = createMockProps(20);
      const newMockState = createMockState(20);
      mockUsePreviewPanelState.mockReturnValue(newMockState);

      rerender(<PreviewPanel {...newMockProps} />);

      expect(
        screen.getByText((_content, element) => {
          return element?.textContent === '20 files | 4,000 tokens';
        })
      ).toBeInTheDocument();
    });

    it('should maintain state consistency during operations', async () => {
      const mockProps = createMockProps(75);
      const mockState = createMockState(75);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Go to page 2
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);

      expect(screen.getByText('Page 2 of 2 (75 total files)')).toBeInTheDocument();

      // Select files on page 2
      const checkboxes = screen.getAllByTestId('checkbox');
      expect(checkboxes[1]).toBeInTheDocument();
      fireEvent.click(checkboxes[1]);

      // Should show selection bar
      await waitFor(() => {
        expect(screen.getByText(/files selected in preview/)).toBeInTheDocument();
      });

      // Clear selection
      const clearButton = screen.getByText('Clear Preview Selection');
      fireEvent.click(clearButton);

      // Selection bar should disappear
      await waitFor(() => {
        expect(screen.queryByText(/files selected in preview/)).not.toBeInTheDocument();
      });
    });
  });

  describe('Accessibility Integration', () => {
    it('should maintain accessibility during complex interactions', () => {
      const mockProps = createMockProps(30);
      const mockState = createMockState(30);
      mockUsePreviewPanelState.mockReturnValue(mockState);

      render(<PreviewPanel {...mockProps} />);

      // Test keyboard navigation through sorting
      const headers = screen.getAllByRole('columnheader');
      for (const header of headers) {
        expect(header).toHaveAttribute('scope', 'col');
      }

      // Test keyboard sorting
      const folderHeader = screen.getByText('Folder');
      fireEvent.keyDown(folderHeader, { key: 'Enter' });
      expect(screen.getAllByTestId('arrow-up').length).toBeGreaterThan(0);

      // Test space key
      fireEvent.keyDown(folderHeader, { key: ' ' });
      expect(screen.getAllByTestId('arrow-down').length).toBeGreaterThan(0);

      // All interactive elements should have proper labels
      const checkboxes = screen.getAllByTestId('checkbox');
      expect(checkboxes[0]).toHaveAttribute('aria-label', 'Select all files on current page');
    });
  });
});
