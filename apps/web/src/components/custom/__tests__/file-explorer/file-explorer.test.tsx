import { useFileExplorerSettings } from '@brainstrike/hooks';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockToast } from '../../../../__mocks__/ui-mocks';
import { useFileExplorer } from '../../../../hooks/use-file-explorer';
import { useFileSystem } from '../../../../hooks/use-file-system';
import { useQuickFilter } from '../../../../hooks/use-quick-filter';
import { useReportGeneration } from '../../../../hooks/use-report-generation';
import { FileExplorerStrings } from '../../constants/file-explorer-constants';
import FileExplorer from '../../file-explorer';
import {
  createMockDirectoryHandle,
  mockFileExplorer,
  mockFileSystem,
  mockQuickFilter,
  mockReportGeneration,
  mockSettings,
} from '../helpers/file-explorer-test-utils';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@brainstrike/ui')>();
  const { mockToast } = await import('../../../../__mocks__/ui-mocks');
  return {
    ...originalModule,
    useToast: () => ({ toast: mockToast }),
  };
});

vi.mock('../../../../hooks/use-file-system');
vi.mock('../../../../hooks/use-file-explorer');
vi.mock('../../../../hooks/use-quick-filter');
vi.mock('@brainstrike/hooks', () => ({
  useFileExplorerSettings: vi.fn(),
}));
vi.mock('../../../../hooks/use-report-generation');

// Mock imported from ui-mocks.ts
// No need to mock useToast here as it's done in ui-mocks.ts

// Mock the store actions needed by FileExplorerConfig
const mockSetFilters = vi.fn();
const mockSetUseRegex = vi.fn();
const mockSetIncludeProjectTree = vi.fn();
const mockSetFolderSummaryThreshold = vi.fn();
const mockSetMaxSelectionCount = vi.fn();

vi.mock('../../../../stores/use-file-explorer-store', async (importOriginal) => {
  const actualStore =
    await importOriginal<typeof import('../../../../stores/use-file-explorer-store')>();
  return {
    ...actualStore, // Keep actual exports if needed elsewhere
    useFileExplorerStore: vi.fn().mockImplementation((selector) => {
      // Provide mock actions and minimal state if necessary
      const state = {
        currentFolderId: 'test', // Example state if needed by FileExplorer
        selectedFilePaths: new Set<string>(), // Ensure this state is provided
        setCurrentFolderId: vi.fn(), // Add missing action used by FileExplorer
        setFilters: mockSetFilters,
        setUseRegex: mockSetUseRegex,
        setIncludeProjectTree: mockSetIncludeProjectTree,
        setFolderSummaryThreshold: mockSetFolderSummaryThreshold,
        setMaxSelectionCount: mockSetMaxSelectionCount,
        // ... add other state/actions used by FileExplorer if needed
      };
      return selector ? selector(state) : state;
    }),
  };
});

describe.skip('FileExplorer', () => {
  beforeEach(() => {
    mockToast.mockClear();
    (useFileSystem as ReturnType<typeof vi.fn>).mockReturnValue(mockFileSystem);
    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue(mockFileExplorer);
    (useQuickFilter as ReturnType<typeof vi.fn>).mockReturnValue(mockQuickFilter);
    (useFileExplorerSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      settings: { ...mockSettings.settings },
      updateSettings: mockSettings.updateSettings,
    });
    (useReportGeneration as ReturnType<typeof vi.fn>).mockReturnValue(mockReportGeneration);

    // Clear store action mocks
    mockSetFilters.mockClear();
    mockSetUseRegex.mockClear();
    mockSetIncludeProjectTree.mockClear();
    mockSetFolderSummaryThreshold.mockClear();
    mockSetMaxSelectionCount.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders without crashing', async () => {
    await act(async () => {
      render(<FileExplorer />);
    });
    await waitFor(() => {
      expect(screen.getByText(FileExplorerStrings.TITLE)).toBeInTheDocument();
    });
  });

  it('shows loading overlay during initial load', async () => {
    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileExplorer,
      isLoading: true,
      isInitialLoad: true,
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        FileExplorerStrings.LOADING.ROOT_DIRECTORY
      );
    });
  });

  it('handles root directory selection', async () => {
    const mockDirectoryHandleInstance = createMockDirectoryHandle();
    const mockSelectRootDirectory = vi.fn().mockResolvedValue(mockDirectoryHandleInstance);

    (useFileSystem as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileSystem,
      selectRootDirectory: mockSelectRootDirectory,
    });
    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileExplorer,
      handleRootDirectorySelect: mockSelectRootDirectory,
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    const selectRootButton = screen.getByText(FileExplorerStrings.SELECT_ROOT);
    await act(async () => {
      await userEvent.click(selectRootButton);
    });

    await waitFor(() => {
      expect(mockSelectRootDirectory).toHaveBeenCalled();
    });
  });

  it('handles refresh', async () => {
    const mockRefreshFileExplorer = vi.fn().mockResolvedValue(undefined);
    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileExplorer,
      rootDirectoryHandle: createMockDirectoryHandle(),
      refreshFileExplorer: mockRefreshFileExplorer,
      isLoading: false,
      isRefreshing: false,
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    const refreshButton = screen.getByText(FileExplorerStrings.REFRESH);
    await act(async () => {
      await userEvent.click(refreshButton);
    });

    await waitFor(() => {
      expect(mockRefreshFileExplorer).toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: FileExplorerStrings.SUCCESS.TITLE,
          description: FileExplorerStrings.SUCCESS.REFRESH_SUCCESS,
        })
      );
    });
  });

  it('handles browser compatibility check', async () => {
    const mockReason = 'Browser not supported';
    (useFileExplorer as ReturnType<typeof vi.fn>).mockReturnValue({
      ...mockFileExplorer,
      isFileSystemAccessSupported: () => ({
        supported: false,
        reason: mockReason,
      }),
    });

    await act(async () => {
      render(<FileExplorer />);
    });

    const selectRootButton = screen.getByText(FileExplorerStrings.SELECT_ROOT);
    await act(async () => {
      await userEvent.click(selectRootButton);
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: FileExplorerStrings.ERROR.BROWSER_COMPATIBILITY,
          description: mockReason,
          variant: 'destructive',
        })
      );
    });
  });
});
