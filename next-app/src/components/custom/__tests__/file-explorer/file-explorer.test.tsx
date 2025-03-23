import { useFileExplorer } from '@/hooks/use-file-explorer';
import { useFileExplorerSettings } from '@/hooks/use-file-explorer-settings';
import { useFileSystem } from '@/hooks/use-file-system';
import { useQuickFilter } from '@/hooks/use-quick-filter';
import { useReportGeneration } from '@/hooks/use-report-generation';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileExplorerStrings } from '../../constants/file-explorer-constants';
import FileExplorer from '../../file-explorer';
import {
  createMockDirectoryHandle,
  defaultMockStore,
  mockFileExplorer,
  mockFileSystem,
  mockQuickFilter,
  mockReportGeneration,
  mockSettings,
  resetDefaultMockStore,
} from '../helpers/file-explorer-test-utils';

jest.mock('@/hooks/use-file-system');
jest.mock('@/hooks/use-file-explorer');
jest.mock('@/hooks/use-quick-filter');
jest.mock('@/hooks/use-file-explorer-settings');
jest.mock('@/hooks/use-report-generation');
jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const mockToast = jest.fn();
jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Reuse a mockStore instance
const mockStore = { ...defaultMockStore };

jest.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: () => mockStore,
}));

describe('FileExplorer', () => {
  beforeEach(() => {
    resetDefaultMockStore(mockStore);
    (useFileSystem as jest.Mock).mockReturnValue(mockFileSystem);
    (useFileExplorer as jest.Mock).mockReturnValue(mockFileExplorer);
    (useQuickFilter as jest.Mock).mockReturnValue(mockQuickFilter);
    (useFileExplorerSettings as jest.Mock).mockReturnValue({
      settings: mockSettings.settings,
      updateSettings: mockSettings.updateSettings,
    });
    (useReportGeneration as jest.Mock).mockReturnValue(mockReportGeneration);
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
    (useFileExplorer as jest.Mock).mockReturnValue({
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
    const mockSelectRootDirectory = jest.fn().mockResolvedValue(mockDirectoryHandleInstance);

    (useFileSystem as jest.Mock).mockReturnValue({
      ...mockFileSystem,
      selectRootDirectory: mockSelectRootDirectory,
    });
    (useFileExplorer as jest.Mock).mockReturnValue({
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
    const mockRefreshFileExplorer = jest.fn().mockResolvedValue(undefined);
    (useFileExplorer as jest.Mock).mockReturnValue({
      ...mockFileExplorer,
      rootDirectoryHandle: createMockDirectoryHandle(),
      refreshFileExplorer: mockRefreshFileExplorer,
      isLoading: false,
      isRefreshing: false,
    });

    mockStore.currentFolderId = 'test';

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
    (useFileExplorer as jest.Mock).mockReturnValue({
      ...mockFileExplorer,
      isFileSystemAccessSupported: () => ({ supported: false, reason: mockReason }),
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
