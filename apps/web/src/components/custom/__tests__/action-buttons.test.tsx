import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStore } from '../../../stores/use-file-explorer-store';
import { resetStore } from '../../../test/test-utils';
import { encodeFileSelection } from '../../../utils/file-selection-utils';
import ActionButtons from '../action-buttons';

vi.mock('@/stores/use-file-explorer-store');

describe('ActionButtons', () => {
  const mockOnDownloadReport = vi.fn();
  const mockOnCopyReport = vi.fn();
  const DEFAULT_MAX_SELECTION = 10;
  const TEST_FOLDER_ID = 'test-folder';

  beforeEach(() => {
    resetStore();
    mockOnDownloadReport.mockClear();
    mockOnCopyReport.mockClear();
    useFileExplorerStore.setState({
      selectedFilePaths: new Set<string>(),
      maxSelectionCount: DEFAULT_MAX_SELECTION,
      currentFolderId: TEST_FOLDER_ID,
    });
  });

  describe('Button Text and State', () => {
    it('should show "Select All" when no files are displayed', () => {
      const displayedFiles = new Set<string>();
      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    });

    it('should show "Select All" when files are within max limit', () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);
      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    });

    it('should show max selection count when files exceed limit', () => {
      const maxSelection = 2;
      const displayedFiles = new Set(['file1.txt', 'file2.txt', 'file3.txt']);
      useFileExplorerStore.setState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: maxSelection,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );
      expect(screen.getByRole('button', { name: `Select ${maxSelection}` })).toBeInTheDocument();
    });

    it('should show "Deselect All" when files are selected', () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);
      useFileExplorerStore.setState({
        selectedFilePaths: new Set([encodeFileSelection(TEST_FOLDER_ID, 'file1.txt')]),
        maxSelectionCount: DEFAULT_MAX_SELECTION,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );
      expect(screen.getByRole('button', { name: 'Deselect All' })).toBeInTheDocument();
    });
  });

  describe('Button Functionality', () => {
    it('should select all files when clicking "Select All" and files are within limit', async () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);
      const mockSetSelectedFiles = vi.fn();
      const user = userEvent.setup();

      useFileExplorerStore.setState({
        selectedFilePaths: new Set<string>(),
        setSelectedFiles: mockSetSelectedFiles,
        maxSelectionCount: DEFAULT_MAX_SELECTION,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      const selectAllButton = screen.getByRole('button', {
        name: 'Select All',
      });
      expect(selectAllButton).not.toBeDisabled();
      await user.click(selectAllButton);

      const expectedSelection = new Set(
        Array.from(displayedFiles).map((path) => encodeFileSelection(TEST_FOLDER_ID, path))
      );
      expect(mockSetSelectedFiles).toHaveBeenCalledWith(expectedSelection);
    });

    it('should select up to max selection limit when files exceed limit', async () => {
      const maxSelection = 2;
      const displayedFiles = new Set(['file1.txt', 'file2.txt', 'file3.txt']);
      const mockSetSelectedFiles = vi.fn();
      const user = userEvent.setup();

      useFileExplorerStore.setState({
        selectedFilePaths: new Set<string>(),
        setSelectedFiles: mockSetSelectedFiles,
        maxSelectionCount: maxSelection,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      const selectButton = screen.getByRole('button', {
        name: `Select ${maxSelection}`,
      });
      await user.click(selectButton);

      const expectedSelection = new Set(
        ['file1.txt', 'file2.txt'].map((path) => encodeFileSelection(TEST_FOLDER_ID, path))
      );
      expect(mockSetSelectedFiles).toHaveBeenCalledWith(expectedSelection);
    });

    it('should deselect all files when clicking "Deselect All"', async () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);
      const mockSetSelectedFiles = vi.fn();
      const user = userEvent.setup();

      const encodedFiles = new Set(
        Array.from(displayedFiles).map((path) => encodeFileSelection(TEST_FOLDER_ID, path))
      );

      useFileExplorerStore.setState({
        selectedFilePaths: encodedFiles,
        setSelectedFiles: mockSetSelectedFiles,
        maxSelectionCount: DEFAULT_MAX_SELECTION,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      const deselectAllButton = screen.getByRole('button', {
        name: 'Deselect All',
      });
      expect(deselectAllButton).not.toBeDisabled();
      await user.click(deselectAllButton);

      expect(mockSetSelectedFiles).toHaveBeenCalledWith(new Set());
    });

    it('should enable select button when files are available even if they exceed max limit', () => {
      const maxSelection = 2;
      const displayedFiles = new Set(['file1.txt', 'file2.txt', 'file3.txt']);

      useFileExplorerStore.setState({
        selectedFilePaths: new Set<string>(),
        maxSelectionCount: maxSelection,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      const selectButton = screen.getByRole('button', {
        name: `Select ${maxSelection}`,
      });
      expect(selectButton).not.toBeDisabled();
    });
  });

  describe('Report Buttons', () => {
    it('should disable report buttons when no files are selected', () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      expect(screen.getByRole('button', { name: /download report/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /copy report/i })).toBeDisabled();
    });

    it('should enable report buttons when files are selected', () => {
      const displayedFiles = new Set(['file1.txt', 'file2.txt']);
      useFileExplorerStore.setState({
        selectedFilePaths: new Set([encodeFileSelection(TEST_FOLDER_ID, 'file1.txt')]),
        maxSelectionCount: DEFAULT_MAX_SELECTION,
        currentFolderId: TEST_FOLDER_ID,
      });

      render(
        <ActionButtons
          displayedFiles={displayedFiles}
          onDownloadReport={mockOnDownloadReport}
          onCopyReport={mockOnCopyReport}
        />
      );

      expect(screen.getByRole('button', { name: /download report/i })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: /copy report/i })).not.toBeDisabled();
    });
  });
});
