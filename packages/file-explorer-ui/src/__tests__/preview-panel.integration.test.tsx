import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview/preview-panel';
import { useWorkspaceContextCurationStore } from '../workspace-context-curation-store';

type PreviewPanelMocksModule = typeof import('./__mocks__/preview-panel-mocks');

const previewPanelMocksPromise = vi.hoisted(
  async () => (await import('./__mocks__/preview-panel-mocks')) as PreviewPanelMocksModule
);

vi.mock('../preview/use-preview-panel-state', async () => {
  const { createUsePreviewPanelStateMock } = await previewPanelMocksPromise;
  return createUsePreviewPanelStateMock();
});

vi.mock('@brainstrike/ui', async () => {
  const { createUiModuleMock } = await previewPanelMocksPromise;
  return createUiModuleMock();
});

vi.mock('@brainstrike/hooks', async () => {
  const { createHooksModuleMock } = await previewPanelMocksPromise;
  return createHooksModuleMock();
});

vi.mock('lucide-react', async () => {
  const { createLucideModuleMock } = await previewPanelMocksPromise;
  return createLucideModuleMock();
});

const mockUsePreviewPanelState = vi.mocked(
  await import('../preview/use-preview-panel-state')
).usePreviewPanelState;

const { resetPreviewPanelPaginationMockState } = await previewPanelMocksPromise;

const createMockProps = (fileCount = 100): ComponentProps<typeof PreviewPanel> => ({
  decodeFileSelection: vi.fn((key: string) => {
    const index = Number.parseInt(key.replace('file', ''), 10);
    const rootIndex = Math.floor(index / 10);
    return {
      folderId: `folder-${rootIndex}`,
      path: `path/to/folder${rootIndex}/${key}.txt`,
    };
  }),
  fileContents: Object.fromEntries(
    Array.from({ length: fileCount }, (_, index) => [
      `file${index}`,
      `content of file ${index}`.repeat(10),
    ])
  ),
  fileSizes: Object.fromEntries(
    Array.from({ length: fileCount }, (_, index) => [`file${index}`, 1024 + index * 100])
  ),
  loadingFiles: new Set<string>(),
  onSelectionChange: vi.fn(),
  performUndoableAction: vi.fn(),
  selectedFiles: new Set(Array.from({ length: fileCount }, (_, index) => `file${index}`)),
  tokenCounting: {
    countTokens: vi.fn(async (content: string) => content.length),
    loading: false,
    mode: 'accurate',
    reason: null,
  },
});

const createMockState = (fileCount = 100) => ({
  batchSelectedFiles: new Set<string>(),
  collapseAllFolders: vi.fn(),
  collapsedFolders: new Set<string>(),
  expandAllFolders: vi.fn(),
  flatListItems: Array.from({ length: fileCount }, (_, index) => ({
    compositeKey: `file${index}`,
    folderId: `folder-${Math.floor(index / 10)}`,
    path: `path/to/folder${Math.floor(index / 10)}/file${index}.txt`,
    size: 1024 + index * 100,
    tokens: 200 + index * 5,
    type: 'file' as const,
  })),
  formatFileSize: vi.fn((bytes?: number) => (bytes === undefined ? 'Unknown' : `${bytes} B`)),
  handleBatchRemove: vi.fn(),
  handleDeselectAll: vi.fn(),
  handleRemoveFile: vi.fn(),
  handleSelectAll: vi.fn(),
  isAllFilesSelected: false,
  loadingFiles: new Set<string>(),
  toggleFileSelection: vi.fn(),
  toggleFolderCollapse: vi.fn(),
  totalStats: {
    pendingCount: 0,
    totalFiles: fileCount,
    totalTokens: fileCount * 200,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetPreviewPanelPaginationMockState();
  localStorage.removeItem('previewPanelPreferences.v1');
  useWorkspaceContextCurationStore.getState().reset();
});

describe('PreviewPanel integration', () => {
  it('completes multi-file selection and batch removal from the gallery overlay', async () => {
    const props = createMockProps(25);
    mockUsePreviewPanelState.mockReturnValue(createMockState(25));
    render(<PreviewPanel {...props} />);

    expect(screen.getByTestId('tapestry-gallery')).toBeInTheDocument();
    for (const path of [
      'path/to/folder0/file1.txt',
      'path/to/folder0/file2.txt',
      'path/to/folder0/file3.txt',
    ]) {
      fireEvent.click(screen.getByLabelText(`Select ${path}`));
    }

    await waitFor(() => {
      expect(within(screen.getByTestId('bulk-action-bar')).getByText('3 selected')).toBeVisible();
    });
    fireEvent.click(screen.getByText('Remove Selected from Project'));

    expect(props.performUndoableAction).toHaveBeenCalledWith(
      'batch-remove',
      'batch-remove',
      expect.objectContaining({
        actionName: 'Files removed',
        itemDescription: 'Removed 3 files from selection',
      })
    );
    const nextSelection = vi.mocked(props.onSelectionChange).mock.calls[0]?.[0];
    expect(nextSelection).toBeInstanceOf(Set);
    expect(nextSelection).not.toContain('file1');
    expect(nextSelection).not.toContain('file2');
    expect(nextSelection).not.toContain('file3');
  });

  it('selects every file on the current fixed-size page', () => {
    const props = createMockProps(200);
    mockUsePreviewPanelState.mockReturnValue(createMockState(200));
    render(<PreviewPanel {...props} />);

    const pageCheckbox = screen.getByLabelText('Select all files on current page');
    fireEvent.click(pageCheckbox);

    expect(pageCheckbox).toBeChecked();
    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
    const visibleCardCheckboxes = screen
      .getAllByTestId('tapestry-document-card')
      .map((card) => within(card).getByRole('checkbox'));
    for (const checkbox of visibleCardCheckboxes) {
      expect(checkbox).toBeChecked();
    }
  });

  it('renders a large dataset as one bounded gallery page', () => {
    const props = createMockProps(1000);
    mockUsePreviewPanelState.mockReturnValue(createMockState(1000));
    render(<PreviewPanel {...props} />);

    expect(screen.getByTestId('page-info')).toHaveTextContent('of 42');
    expect(screen.getByTestId('item-range')).toHaveTextContent('1-24 of 1000');
    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
    expect(screen.getByText('file0.txt')).toBeInTheDocument();
  });

  it('handles rapid page navigation while keeping the gallery bounded', () => {
    const props = createMockProps(500);
    mockUsePreviewPanelState.mockReturnValue(createMockState(500));
    render(<PreviewPanel {...props} />);

    const nextButton = screen.getByRole('button', { name: 'Go to next page' });
    for (let count = 0; count < 5; count += 1) {
      fireEvent.click(nextButton);
    }

    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(6);
    expect(screen.getByTestId('page-info')).toHaveTextContent('of 21');
    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
  });

  it('keeps loading, missing, and ready files observable together', () => {
    const props = createMockProps(50);
    props.loadingFiles = new Set(['file1', 'file2']);
    props.fileContents = Object.fromEntries(
      Object.entries(props.fileContents).filter(
        ([key]) => !['file1', 'file2', 'file3'].includes(key)
      )
    );
    mockUsePreviewPanelState.mockReturnValue(createMockState(50));
    render(<PreviewPanel {...props} />);

    expect(
      screen.getByRole('button', { name: 'Loading file content for file1.txt' })
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('button', { name: 'Loading file content for file3.txt' })
    ).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('file0.txt')).toBeInTheDocument();
    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
  });

  it('updates the gallery when the selected file set changes', () => {
    const initialProps = createMockProps(10);
    mockUsePreviewPanelState.mockReturnValue(createMockState(10));
    const { rerender } = render(<PreviewPanel {...initialProps} />);
    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(10);

    const expandedProps = createMockProps(20);
    mockUsePreviewPanelState.mockReturnValue(createMockState(20));
    rerender(<PreviewPanel {...expandedProps} />);

    expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(20);
    expect(screen.getByText('file19.txt')).toBeInTheDocument();
    expect(screen.getByText(/20 files/i)).toBeInTheDocument();
  });

  it('keeps page-local selection consistent across navigation and clear', async () => {
    const props = createMockProps(75);
    mockUsePreviewPanelState.mockReturnValue(createMockState(75));
    render(<PreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));

    const firstVisibleCard = screen.getAllByTestId('tapestry-document-card')[0];
    if (!firstVisibleCard) {
      throw new Error('Expected a visible document card on page two');
    }
    const fileCheckbox = within(firstVisibleCard).getByRole('checkbox');
    fireEvent.click(fileCheckbox);
    expect(screen.getByTestId('bulk-action-bar')).toHaveTextContent('1 file selected');

    fireEvent.click(screen.getByRole('button', { name: 'Clear context selection' }));

    await waitFor(() => {
      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
    expect(fileCheckbox).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
  });

  it('returns to the first page when a file-set reduction invalidates the current page', async () => {
    const props = createMockProps(49);
    mockUsePreviewPanelState.mockReturnValue(createMockState(49));
    const { rerender } = render(<PreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Go to last page' }));
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);

    const fewerProps = createMockProps(5);
    mockUsePreviewPanelState.mockReturnValue(createMockState(5));
    rerender(<PreviewPanel {...fewerProps} />);

    await waitFor(() => {
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);
      expect(screen.getByTestId('page-info')).toHaveTextContent('of 1');
    });
  });

  it('retains accessible Tapestry controls through grouping and collapse', () => {
    const props = createMockProps(30);
    mockUsePreviewPanelState.mockReturnValue(createMockState(30));
    render(<PreviewPanel {...props} />);

    expect(screen.getByTestId('tapestry-command-dock')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all files on current page')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'By Root Folder' }));

    const groupHeaders = screen.getAllByTestId('tapestry-group-header');
    expect(groupHeaders.length).toBeGreaterThan(0);
    expect(
      within(groupHeaders[0]!).getByRole('checkbox', { name: /select all items in group/i })
    ).toBeInTheDocument();
    const collapseButton = within(groupHeaders[0]!).getByRole('button', {
      name: /collapse group/i,
    });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapseButton);
    expect(collapseButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('publishes each selected file root identity and display name', async () => {
    const props = createMockProps(2);
    mockUsePreviewPanelState.mockReturnValue(createMockState(2));
    render(
      <PreviewPanel {...props} resolveRootDisplayName={(rootId: string) => `name-of-${rootId}`} />
    );

    await waitFor(() => {
      const snapshot = useWorkspaceContextCurationStore.getState().contextSnapshot;
      expect(snapshot?.files).toHaveLength(2);
      expect(snapshot?.files[0]).toEqual(
        expect.objectContaining({
          rootDisplayName: 'name-of-folder-0',
          rootId: 'folder-0',
        })
      );
    });
  });
});
