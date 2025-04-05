import { jsx as _jsx } from "react/jsx-runtime";
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorer } from '../../../../hooks/use-file-explorer';
import { useFileExplorerSettings } from '../../../../hooks/use-file-explorer-settings';
import { useFileSystem } from '../../../../hooks/use-file-system';
import { useQuickFilter } from '../../../../hooks/use-quick-filter';
import { useReportGeneration } from '../../../../hooks/use-report-generation';
import { FileExplorerStrings } from '../../constants/file-explorer-constants';
import FileExplorer from '../../file-explorer';
import { createMockDirectoryHandle, defaultMockStore, mockFileExplorer, mockFileSystem, mockQuickFilter, mockReportGeneration, mockSettings, resetDefaultMockStore, } from '../helpers/file-explorer-test-utils';
vi.mock('../../../../hooks/use-file-system');
vi.mock('../../../../hooks/use-file-explorer');
vi.mock('../../../../hooks/use-quick-filter');
vi.mock('../../../../hooks/use-file-explorer-settings');
vi.mock('../../../../hooks/use-report-generation');
vi.mock('../../../../components/ui/button', () => ({
    Button: ({ children, onClick, disabled, }) => (_jsx("button", { type: "button", onClick: onClick, disabled: disabled, children: children })),
}));
const mockToast = vi.fn();
vi.mock('../../../../components/ui/use-toast', () => ({
    useToast: () => ({ toast: mockToast }),
}));
// Reuse a mockStore instance
const mockStore = { ...defaultMockStore };
vi.mock('../../../../stores/use-file-explorer-store', () => ({
    useFileExplorerStore: () => mockStore,
}));
describe('FileExplorer', () => {
    beforeEach(() => {
        resetDefaultMockStore(mockStore);
        useFileSystem.mockReturnValue(mockFileSystem);
        useFileExplorer.mockReturnValue(mockFileExplorer);
        useQuickFilter.mockReturnValue(mockQuickFilter);
        useFileExplorerSettings.mockReturnValue({
            settings: mockSettings.settings,
            updateSettings: mockSettings.updateSettings,
        });
        useReportGeneration.mockReturnValue(mockReportGeneration);
    });
    afterEach(() => {
        cleanup();
    });
    it('renders without crashing', async () => {
        await act(async () => {
            render(_jsx(FileExplorer, {}));
        });
        await waitFor(() => {
            expect(screen.getByText(FileExplorerStrings.TITLE)).toBeInTheDocument();
        });
    });
    it('shows loading overlay during initial load', async () => {
        useFileExplorer.mockReturnValue({
            ...mockFileExplorer,
            isLoading: true,
            isInitialLoad: true,
        });
        await act(async () => {
            render(_jsx(FileExplorer, {}));
        });
        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent(FileExplorerStrings.LOADING.ROOT_DIRECTORY);
        });
    });
    it('handles root directory selection', async () => {
        const mockDirectoryHandleInstance = createMockDirectoryHandle();
        const mockSelectRootDirectory = vi.fn().mockResolvedValue(mockDirectoryHandleInstance);
        useFileSystem.mockReturnValue({
            ...mockFileSystem,
            selectRootDirectory: mockSelectRootDirectory,
        });
        useFileExplorer.mockReturnValue({
            ...mockFileExplorer,
            handleRootDirectorySelect: mockSelectRootDirectory,
        });
        await act(async () => {
            render(_jsx(FileExplorer, {}));
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
        useFileExplorer.mockReturnValue({
            ...mockFileExplorer,
            rootDirectoryHandle: createMockDirectoryHandle(),
            refreshFileExplorer: mockRefreshFileExplorer,
            isLoading: false,
            isRefreshing: false,
        });
        mockStore.currentFolderId = 'test';
        await act(async () => {
            render(_jsx(FileExplorer, {}));
        });
        const refreshButton = screen.getByText(FileExplorerStrings.REFRESH);
        await act(async () => {
            await userEvent.click(refreshButton);
        });
        await waitFor(() => {
            expect(mockRefreshFileExplorer).toHaveBeenCalled();
            expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
                title: FileExplorerStrings.SUCCESS.TITLE,
                description: FileExplorerStrings.SUCCESS.REFRESH_SUCCESS,
            }));
        });
    });
    it('handles browser compatibility check', async () => {
        const mockReason = 'Browser not supported';
        useFileExplorer.mockReturnValue({
            ...mockFileExplorer,
            isFileSystemAccessSupported: () => ({ supported: false, reason: mockReason }),
        });
        await act(async () => {
            render(_jsx(FileExplorer, {}));
        });
        const selectRootButton = screen.getByText(FileExplorerStrings.SELECT_ROOT);
        await act(async () => {
            await userEvent.click(selectRootButton);
        });
        await waitFor(() => {
            expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
                title: FileExplorerStrings.ERROR.BROWSER_COMPATIBILITY,
                description: mockReason,
                variant: 'destructive',
            }));
        });
    });
});
