import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreviewPanel } from '../preview/preview-panel';

vi.mock('../preview/use-preview-panel-state', async () => {
  const { createUsePreviewPanelStateMock } = await import('./__mocks__/preview-panel-mocks');
  return createUsePreviewPanelStateMock();
});

vi.mock('@brainstrike/ui', async () => {
  const { createUiModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createUiModuleMock();
});

vi.mock('@brainstrike/hooks', async () => {
  const { createHooksModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createHooksModuleMock();
});

vi.mock('../tapestry/tapestry-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tapestry/tapestry-adapter')>();

  return {
    ...actual,
    buildTapestryFileBase: vi.fn(actual.buildTapestryFileBase),
  };
});

vi.mock('lucide-react', async () => {
  const { createLucideModuleMock } = await import('./__mocks__/preview-panel-mocks');
  return createLucideModuleMock();
});

const mockUsePreviewPanelState = vi.mocked(
  await import('../preview/use-preview-panel-state')
).usePreviewPanelState;
const mockUsePagination = vi.mocked((await import('@brainstrike/hooks')).usePagination);
const mockBuildTapestryFileBase = vi.mocked(
  (await import('../tapestry/tapestry-adapter')).buildTapestryFileBase
);

const { resetPreviewPanelPaginationMockState } = await import('./__mocks__/preview-panel-mocks');

interface TestFileItem {
  compositeKey: string;
  folderId: string;
  path: string;
  tokens: number;
  type: 'file';
}

const buildItem = (index: number): TestFileItem => ({
  compositeKey: `file${index}`,
  folderId: 'root',
  path: `path/to/file${index}.txt`,
  tokens: 100 + index,
  type: 'file',
});

const buildState = (items: TestFileItem[]) => ({
  flatListItems: items,
  loadingFiles: new Set<string>(),
  totalStats: {
    pendingCount: 0,
    totalFiles: items.length,
    totalTokens: items.reduce((total, item) => total + item.tokens, 0),
  },
});

const baseProps: ComponentProps<typeof PreviewPanel> = {
  decodeFileSelection: (key) => ({ folderId: 'root', path: `path/to/${key}.txt` }),
  fileContents: {},
  loadingFiles: new Set<string>(),
  onSelectionChange: vi.fn(),
  performUndoableAction: vi.fn(),
  selectedFiles: new Set<string>(),
  tokenCounting: {
    countTokens: vi.fn(async (content: string) => content.length),
    loading: false,
    mode: 'accurate',
    reason: null,
  },
};

beforeEach(() => {
  resetPreviewPanelPaginationMockState();
  localStorage.removeItem('previewPanelPreferences.v1');
  vi.clearAllMocks();
});

describe('PreviewPanel deferred selection pipeline', () => {
  it('preserves the current page while rows and replacement selection advance together', async () => {
    const initialItems = Array.from({ length: 72 }, (_, index) => buildItem(index));
    const nextItems = Array.from({ length: 72 }, (_, index) => buildItem(index + 48));
    const fileContents = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`file${index}`, `content ${index}`])
    );

    mockUsePreviewPanelState.mockReturnValue(buildState(initialItems));
    const { rerender } = render(
      <PreviewPanel
        {...baseProps}
        fileContents={fileContents}
        selectedFiles={new Set(initialItems.map((item) => item.compositeKey))}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go to last page' }));
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);

    mockUsePagination.mockClear();
    mockUsePreviewPanelState.mockReturnValue(buildState(nextItems));
    rerender(
      <PreviewPanel
        {...baseProps}
        fileContents={fileContents}
        selectedFiles={new Set(nextItems.map((item) => item.compositeKey))}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId('item-range')).toHaveTextContent('49-72 of 72');
    });

    const observedTotals = mockUsePagination.mock.calls.map(([options]) => options.totalItems);

    // Only 24 keys overlap the old rows and new selection. The gallery may see
    // either coherent 72-row snapshot, but never that transient intersection.
    expect(observedTotals).not.toContain(24);
    expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);
  });

  it('retains a cached base while a deselected row remains in the deferred snapshot', () => {
    const items = [buildItem(1), buildItem(2)];
    const state = buildState(items);
    const fileContents = {
      file1: 'file one\ncontent',
      file2: 'file two\ncontent',
    };
    const loadingFiles = new Set<string>();

    // Keep this exact state object for every render: file2 never leaves the
    // deferred row snapshot.
    mockUsePreviewPanelState.mockReturnValue(state);
    const { rerender } = render(
      <PreviewPanel
        {...baseProps}
        fileContents={fileContents}
        loadingFiles={loadingFiles}
        selectedFiles={new Set(['file1', 'file2'])}
      />
    );

    expect(mockBuildTapestryFileBase).toHaveBeenCalledWith(
      expect.objectContaining({ item: expect.objectContaining({ compositeKey: 'file2' }) })
    );

    mockBuildTapestryFileBase.mockClear();
    rerender(
      <PreviewPanel
        {...baseProps}
        fileContents={fileContents}
        loadingFiles={loadingFiles}
        selectedFiles={new Set(['file1'])}
      />
    );
    expect(
      mockBuildTapestryFileBase.mock.calls.map(([args]) => args.item.compositeKey)
    ).not.toContain('file2');

    mockBuildTapestryFileBase.mockClear();
    rerender(
      <PreviewPanel
        {...baseProps}
        fileContents={fileContents}
        loadingFiles={loadingFiles}
        selectedFiles={new Set(['file1', 'file2'])}
      />
    );

    // Unchanged content, metadata, loading state, and row reuse the warm base.
    expect(
      mockBuildTapestryFileBase.mock.calls.map(([args]) => args.item.compositeKey)
    ).not.toContain('file2');
    expect(screen.getByText('file2.txt')).toBeInTheDocument();
  });
});
