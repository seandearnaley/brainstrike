import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

interface TestFileItem {
  compositeKey: string;
  folderId: string;
  path: string;
  size?: number;
  tokens?: number;
  type: 'file';
}

const buildItem = (index: number, overrides: Partial<TestFileItem> = {}): TestFileItem => ({
  compositeKey: `file${index}`,
  folderId: 'root',
  path: `path/to/file${index}.txt`,
  size: 1024 + index,
  tokens: 100 + index,
  type: 'file',
  ...overrides,
});

const buildState = (items: TestFileItem[]) => ({
  flatListItems: items,
  loadingFiles: new Set<string>(),
  totalStats: {
    pendingCount: 0,
    totalFiles: items.length,
    totalTokens: items.reduce((total, item) => total + (item.tokens ?? 0), 0),
  },
});

const baseItems: TestFileItem[] = [
  buildItem(1, { folderId: 'folder-file1', size: 1024, tokens: 500 }),
  buildItem(2, { folderId: 'folder-file2', size: 2048, tokens: 750 }),
  buildItem(3, { folderId: 'folder-file3', size: 512, tokens: 250 }),
];

const baseProps: ComponentProps<typeof PreviewPanel> = {
  decodeFileSelection: vi.fn((key: string) => ({
    folderId: `folder-${key}`,
    path: `path/to/${key}.txt`,
  })),
  fileContents: {
    file1: 'content1',
    file2: 'content2',
    file3: 'content3',
  },
  fileSizes: {
    file1: 1024,
    file2: 2048,
    file3: 512,
  },
  loadingFiles: new Set<string>(),
  onSelectionChange: vi.fn(),
  performUndoableAction: vi.fn(),
  selectedFiles: new Set(['file1', 'file2', 'file3']),
  tokenCounting: {
    countTokens: vi.fn(async (content: string) => content.length),
    loading: false,
    mode: 'accurate',
    reason: null,
  },
};

const selectGroupingOption = (label: string): void => {
  fireEvent.click(screen.getByRole('button', { name: 'View options' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
};

const renderWithItems = (
  items: TestFileItem[],
  props: Partial<ComponentProps<typeof PreviewPanel>> = {}
) => {
  mockUsePreviewPanelState.mockReturnValue(buildState(items));
  const keys = items.map((item) => item.compositeKey);
  return render(
    <PreviewPanel
      {...baseProps}
      fileContents={Object.fromEntries(keys.map((key) => [key, `content for ${key}`]))}
      selectedFiles={new Set(keys)}
      {...props}
    />
  );
};

beforeEach(() => {
  resetPreviewPanelPaginationMockState();
  localStorage.removeItem('previewPanelPreferences.v1');
  useWorkspaceContextCurationStore.getState().reset();
  vi.clearAllMocks();
  mockUsePreviewPanelState.mockReturnValue(buildState(baseItems));
});

describe('PreviewPanel', () => {
  describe('surface and footer', () => {
    it('renders the empty state when no files are selected', () => {
      render(<PreviewPanel {...baseProps} selectedFiles={new Set()} />);

      expect(screen.getByText('No files selected')).toBeInTheDocument();
      expect(
        screen.getByText('Select files from the explorer to include them in your project context')
      ).toBeInTheDocument();
    });

    it('renders Tapestry as the only preview surface', () => {
      render(<PreviewPanel {...baseProps} />);

      expect(screen.getByTestId('tapestry-command-dock')).toBeInTheDocument();
      expect(screen.getByTestId('tapestry-gallery')).toBeInTheDocument();
      expect(screen.getByRole('slider', { name: 'Gallery scale' })).toBeInTheDocument();
      expect(screen.queryByRole('tab')).not.toBeInTheDocument();
      expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    });

    it('renders context actions and wires their callbacks', async () => {
      const user = userEvent.setup();
      const onDownloadContext = vi.fn();
      const onCopyContext = vi.fn();
      const onIncludeProjectTreeChange = vi.fn();
      const onProjectTreeUsesViewFiltersChange = vi.fn();

      render(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={true}
          onCopyContext={onCopyContext}
          onDownloadContext={onDownloadContext}
          onIncludeProjectTreeChange={onIncludeProjectTreeChange}
          onProjectTreeUsesViewFiltersChange={onProjectTreeUsesViewFiltersChange}
        />
      );

      await user.click(screen.getByRole('button', { name: /download context/i }));
      await user.click(screen.getByRole('button', { name: /copy context/i }));
      expect(onDownloadContext).toHaveBeenCalledWith(
        expect.objectContaining({ selectedLineRangesByFile: {} })
      );
      expect(onCopyContext).toHaveBeenCalledWith(
        expect.objectContaining({ selectedLineRangesByFile: {} })
      );

      await user.click(screen.getByRole('switch', { name: /include project tree/i }));
      expect(onIncludeProjectTreeChange).toHaveBeenCalledWith(false);
      await user.click(screen.getByRole('switch', { name: /use filtered project tree/i }));
      expect(onProjectTreeUsesViewFiltersChange).toHaveBeenCalledWith(true);
    });

    it('hides the filtered-tree control when the project tree is disabled', () => {
      render(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={false}
          onProjectTreeUsesViewFiltersChange={vi.fn()}
        />
      );

      expect(
        screen.queryByRole('switch', { name: /use filtered project tree/i })
      ).not.toBeInTheDocument();
    });

    it('renders summary modes without footer resize affordances', async () => {
      const user = userEvent.setup();
      render(<PreviewPanel {...baseProps} />);

      expect(screen.getByRole('button', { name: /compact summary mode/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /balanced summary mode/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: /insights summary mode/i })).toBeInTheDocument();
      expect(
        screen.queryByRole('separator', { name: /resize context explorer footer/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /collapse footer/i })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /compact summary mode/i }));
      expect(screen.getByRole('button', { name: /compact summary mode/i })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: /download context/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /copy context/i })).toBeInTheDocument();
    });

    it('disables context actions when there is no selection', () => {
      render(
        <PreviewPanel
          {...baseProps}
          onCopyContext={vi.fn()}
          onDownloadContext={vi.fn()}
          selectedFiles={new Set()}
        />
      );

      expect(screen.getByRole('button', { name: /download context/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /copy context/i })).toBeDisabled();
    });

    it('shows file totals, token mode, and the accessible token meter', () => {
      render(<PreviewPanel {...baseProps} />);

      expect(screen.getByText(/1,500 output/i)).toBeInTheDocument();
      expect(screen.getByText(/1,500 source/i)).toBeInTheDocument();
      expect(screen.getByText('WASM')).toBeInTheDocument();
      expect(screen.getByRole('meter')).toHaveAttribute(
        'aria-label',
        expect.stringContaining('Token usage')
      );
    });

    it('surfaces explicit heuristic token-counting mode', () => {
      render(
        <PreviewPanel
          {...baseProps}
          tokenCounting={{
            countTokens: vi.fn(async () => 0),
            loading: false,
            mode: 'heuristic',
            reason: 'preference-disabled',
          }}
        />
      );

      expect(screen.getByText('Heuristic')).toBeInTheDocument();
    });

    it('shows included, excluded, loading, and over-budget tree states', () => {
      const { rerender } = render(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={true}
          projectTreeTokenCount={25_000}
          tokenBudget={100_000}
        />
      );
      expect(screen.getByText(/25,000 tree/i)).toBeInTheDocument();

      rerender(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={false}
          projectTreeTokenCount={25_000}
          tokenBudget={100_000}
        />
      );
      expect(screen.getByText(/0 tree/i)).toBeInTheDocument();

      rerender(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={true}
          projectTreeTokenCount={0}
          projectTreeTokenCountLoading={true}
          tokenBudget={100_000}
        />
      );
      expect(screen.getByText('…')).toBeInTheDocument();

      rerender(
        <PreviewPanel
          {...baseProps}
          includeProjectTree={true}
          projectTreeTokenCount={120_000}
          tokenBudget={100_000}
        />
      );
      expect(screen.getByText(/^over$/i)).toBeInTheDocument();
    });

    it('shows zero output tokens', () => {
      mockUsePreviewPanelState.mockReturnValue({
        ...buildState(baseItems),
        totalStats: { pendingCount: 0, totalFiles: 3, totalTokens: 0 },
      });

      render(<PreviewPanel {...baseProps} />);

      expect(screen.getByText(/0 output/i)).toBeInTheDocument();
    });

    it('edits the token budget', () => {
      const onTokenBudgetChange = vi.fn();
      render(
        <PreviewPanel
          {...baseProps}
          onTokenBudgetChange={onTokenBudgetChange}
          tokenBudget={100_000}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /click to edit token budget/i }));
      fireEvent.change(screen.getByLabelText(/token budget input/i), {
        target: { value: '1,000,000' },
      });
      fireEvent.click(screen.getByRole('button', { name: /apply budget/i }));

      expect(onTokenBudgetChange).toHaveBeenCalledWith(1_000_000);
    });
  });

  describe('file rendering and selection', () => {
    it('renders file cards in fixed root order while preserving source order within a root', () => {
      const items = [
        buildItem(1, { folderId: 'root-z' }),
        buildItem(2, { folderId: 'root-a' }),
        buildItem(3, { folderId: 'root-a' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: key === 'file1' ? 'root-z' : 'root-a',
          path: `path/to/${key}.txt`,
        })),
      });

      const names = screen
        .getAllByTestId('tapestry-document-card')
        .map((card) => within(card).getByText(/file\d+\.txt/).textContent);
      expect(names).toEqual(['file2.txt', 'file3.txt', 'file1.txt']);
    });

    it('toggles an individual file selection', () => {
      render(<PreviewPanel {...baseProps} />);

      const checkbox = screen.getByLabelText('Select path/to/file1.txt');
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it('selects and deselects every file on the current page', () => {
      render(<PreviewPanel {...baseProps} />);

      const pageCheckbox = screen.getByLabelText('Select all files on current page');
      fireEvent.click(pageCheckbox);
      expect(screen.getByLabelText('Select path/to/file1.txt')).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file3.txt')).toBeChecked();

      fireEvent.click(pageCheckbox);
      expect(screen.getByLabelText('Select path/to/file1.txt')).not.toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).not.toBeChecked();
      expect(screen.getByLabelText('Select path/to/file3.txt')).not.toBeChecked();
    });

    // The grouped branch of `getVisibleFilesOnPage` has its own index walk (it
    // counts group headers as page slots), and it is the path the desktop e2e
    // hook reads `renderedFilePaths` from. Ungrouped page select-all above does
    // NOT exercise it.
    it('selects every file on the current page across groups', () => {
      const items = [
        buildItem(1, { folderId: 'root-a' }),
        buildItem(2, { folderId: 'root-b' }),
        buildItem(3, { folderId: 'root-b' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: key === 'file1' ? 'root-a' : 'root-b',
          path: `path/to/${key}.txt`,
        })),
      });
      selectGroupingOption('By Root Folder');
      expect(screen.getAllByTestId('tapestry-group-header')).toHaveLength(2);

      fireEvent.click(screen.getByLabelText('Select all files on current page'));

      for (const name of ['file1', 'file2', 'file3']) {
        expect(screen.getByLabelText(`Select path/to/${name}.txt`)).toBeChecked();
      }
      // Both group headings reflect the page-wide selection, not just the one
      // that happened to own the first slot.
      const groupCheckboxes = screen.getAllByRole('checkbox', {
        name: /^Select all items in group /,
      });
      expect(groupCheckboxes).toHaveLength(2);
      for (const checkbox of groupCheckboxes) {
        expect(checkbox).toBeChecked();
      }
      expect(within(screen.getByTestId('bulk-action-bar')).getByText('3 selected')).toBeVisible();
    });

    it('deselects one file after selecting the page and reports the remaining selection', () => {
      render(<PreviewPanel {...baseProps} />);

      fireEvent.click(screen.getByLabelText('Select all files on current page'));
      fireEvent.click(screen.getByLabelText('Select path/to/file2.txt'));

      expect(screen.getByLabelText('Select path/to/file1.txt')).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).not.toBeChecked();
      expect(screen.getByLabelText('Select path/to/file3.txt')).toBeChecked();
      expect(within(screen.getByTestId('bulk-action-bar')).getByText('2 selected')).toBeVisible();
    });

    it('clears the current preview selection from the bulk bar', () => {
      render(<PreviewPanel {...baseProps} />);
      fireEvent.click(screen.getByLabelText('Select path/to/file1.txt'));

      fireEvent.click(screen.getByRole('button', { name: 'Clear context selection' }));

      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Select path/to/file1.txt')).not.toBeChecked();
    });

    it('removes selected files through the bulk action overlay', async () => {
      const onSelectionChange = vi.fn();
      const performUndoableAction = vi.fn();
      render(
        <PreviewPanel
          {...baseProps}
          onSelectionChange={onSelectionChange}
          performUndoableAction={performUndoableAction}
        />
      );
      fireEvent.click(screen.getByLabelText('Select path/to/file1.txt'));

      expect(screen.getByTestId('selection-action-overlay')).toHaveClass(
        'flex',
        'justify-center',
        'px-3'
      );
      fireEvent.click(screen.getByText('Remove Selected from Project'));

      expect(performUndoableAction).toHaveBeenCalledWith(
        'batch-remove',
        'batch-remove',
        expect.objectContaining({ itemDescription: 'Removed 1 files from selection' })
      );
      await waitFor(() => {
        const nextSelection = onSelectionChange.mock.calls[0]?.[0] as Set<string> | undefined;
        expect(nextSelection).toEqual(new Set(['file2', 'file3']));
      });
      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
  });

  describe('pagination', () => {
    const pageItems = Array.from({ length: 49 }, (_, index) =>
      buildItem(index, { folderId: 'root' })
    );

    it('uses a fixed page size of 24 and renders navigation controls', () => {
      renderWithItems(pageItems);

      expect(screen.getByTestId('page-info')).toHaveTextContent('of 3');
      expect(screen.getByTestId('item-range')).toHaveTextContent('1-24 of 49');
      expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
      expect(screen.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
    });

    it('navigates forward, backward, and directly to the last page', () => {
      renderWithItems(pageItems);

      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(2);
      expect(screen.getByTestId('item-range')).toHaveTextContent('25-48 of 49');

      fireEvent.click(screen.getByRole('button', { name: 'Go to previous page' }));
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);

      fireEvent.click(screen.getByRole('button', { name: 'Go to last page' }));
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);
      expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go to last page' })).toBeDisabled();
    });

    it('resets to the first page when the current page goes out of bounds', async () => {
      const { rerender } = renderWithItems(pageItems);
      fireEvent.click(screen.getByRole('button', { name: 'Go to last page' }));
      expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(3);

      const smallerItems = pageItems.slice(0, 5);
      mockUsePreviewPanelState.mockReturnValue(buildState(smallerItems));
      rerender(
        <PreviewPanel
          {...baseProps}
          fileContents={Object.fromEntries(
            smallerItems.map((item) => [item.compositeKey, `content for ${item.compositeKey}`])
          )}
          selectedFiles={new Set(smallerItems.map((item) => item.compositeKey))}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('spinbutton', { name: 'Page number' })).toHaveValue(1);
        expect(screen.getByTestId('page-info')).toHaveTextContent('of 1');
      });
    });
  });

  describe('loading and invalid data', () => {
    it('renders a loading file without blocking the gallery', () => {
      render(
        <PreviewPanel
          {...baseProps}
          fileContents={{ file2: 'content2', file3: 'content3' }}
          loadingFiles={new Set(['file1'])}
        />
      );

      expect(
        screen.getByRole('button', { name: 'Loading file content for file1.txt' })
      ).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(3);
      expect(screen.getAllByTestId('tapestry-track')[0]).toHaveAttribute('aria-busy', 'true');
    });

    it('renders files with missing content as unavailable previews', () => {
      render(<PreviewPanel {...baseProps} fileContents={{ file1: 'content1' }} />);

      expect(screen.getByText('file2.txt')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Loading file content for file2.txt' })
      ).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByText('file3.txt')).toBeInTheDocument();
    });

    it('skips malformed composite keys and keeps valid files visible', () => {
      const malformedItem = buildItem(4, {
        compositeKey: 'malformed',
        path: 'path/to/malformed.txt',
      });
      const items = [baseItems[0]!, malformedItem, baseItems[2]!];
      mockUsePreviewPanelState.mockReturnValue(buildState(items));

      expect(() =>
        render(
          <PreviewPanel
            {...baseProps}
            decodeFileSelection={(key: string) => {
              if (key === 'malformed') {
                throw new Error('Invalid key format');
              }
              return { folderId: `folder-${key}`, path: `path/to/${key}.txt` };
            }}
            selectedFiles={new Set(['file1', 'malformed', 'file3'])}
          />
        )
      ).not.toThrow();

      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      expect(screen.getByText('file3.txt')).toBeInTheDocument();
      expect(screen.queryByText('malformed.txt')).not.toBeInTheDocument();
    });
  });

  describe('grouping', () => {
    it('offers every surviving grouping mode', () => {
      render(<PreviewPanel {...baseProps} />);
      fireEvent.click(screen.getByRole('button', { name: 'View options' }));

      expect(screen.getByTestId('tapestry-command-dock')).toBeInTheDocument();
      expect(screen.getAllByRole('menuitemradio')).toHaveLength(6);
      for (const label of [
        'By Directory',
        'By Root Folder',
        'By File Type',
        'By Size Range',
        'By Token Range',
        'No Grouping',
      ]) {
        expect(screen.getByRole('menuitemradio', { name: label })).toBeInTheDocument();
      }
    });

    it('migrates the legacy folder preference to root-folder grouping', () => {
      localStorage.setItem(
        'previewPanelPreferences.v1',
        JSON.stringify({ groupingConfig: 'folder' })
      );

      render(<PreviewPanel {...baseProps} />);

      expect(screen.getByRole('menuitemradio', { name: 'By Root Folder' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(screen.getAllByTestId('tapestry-group-header')).toHaveLength(3);
    });

    it('groups directory paths with root-prefixed labels', () => {
      const items = [
        buildItem(1, { folderId: 'project', path: 'src/components/file1.tsx' }),
        buildItem(2, { folderId: 'project', path: 'src/components/file2.tsx' }),
        buildItem(3, { folderId: 'project', path: 'src/utils/file3.ts' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'project',
          path: key === 'file3' ? 'src/utils/file3.ts' : `src/components/${key}.tsx`,
        })),
      });

      selectGroupingOption('By Directory');

      const headers = screen.getAllByTestId('tapestry-group-header');
      expect(headers).toHaveLength(2);
      expect(within(headers[0]!).getByText('project/src/components')).toBeInTheDocument();
      expect(within(headers[1]!).getByText('project/src/utils')).toBeInTheDocument();
      expect(screen.getAllByTestId('tapestry-group-token-count')).toHaveLength(2);
    });

    it('uses root-prefixed directory labels for absolute desktop paths', () => {
      const items = [
        buildItem(1, {
          folderId: '/Users/me/BrainStrike',
          path: '/Users/me/BrainStrike/README.md',
        }),
        buildItem(2, {
          folderId: '/Users/me/BrainStrike',
          path: '/Users/me/BrainStrike/source/index.ts',
        }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: '/Users/me/BrainStrike',
          path:
            key === 'file1'
              ? '/Users/me/BrainStrike/README.md'
              : '/Users/me/BrainStrike/source/index.ts',
        })),
      });

      selectGroupingOption('By Directory');

      const headers = screen.getAllByTestId('tapestry-group-header');
      expect(headers[0]).toHaveTextContent('BrainStrike');
      expect(headers[1]).toHaveTextContent('BrainStrike/source');
      expect(screen.queryByText('.')).not.toBeInTheDocument();
    });

    it('groups by root folder and preserves an absolute root identity', () => {
      const items = [
        buildItem(1, { folderId: '/Users/me/project', path: '/Users/me/project/src/file1.ts' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn(() => ({
          folderId: '/Users/me/project',
          path: '/Users/me/project/src/file1.ts',
        })),
      });

      selectGroupingOption('By Root Folder');

      expect(screen.getByTestId('tapestry-group-header')).toHaveTextContent('/Users/me/project');
    });

    it.each([
      ['By File Type', ['js', 'ts']],
      ['By Size Range', ['Small (< 1 KB)', 'Medium (1-10 KB)']],
      ['By Token Range', ['Medium (100-500)', 'Large (500-1K)']],
    ])('groups files with %s', (label, expectedGroups) => {
      const items = [
        buildItem(1, { path: 'src/file1.js', size: 512, tokens: 250 }),
        buildItem(2, { path: 'src/file2.ts', size: 2048, tokens: 750 }),
        buildItem(3, { path: 'src/file3.js', size: 1024, tokens: 500 }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'root',
          path: key === 'file2' ? `src/${key}.ts` : `src/${key}.js`,
        })),
      });

      selectGroupingOption(label);

      // Exactly-one, not `.some(...)`: a membership check passes just as happily
      // with a duplicated band or a third unexpected group.
      const headerLabels = screen
        .getAllByTestId('tapestry-group-header')
        .map((header) => header.textContent ?? '');
      for (const expectedGroup of expectedGroups) {
        expect(headerLabels.filter((label) => label.includes(expectedGroup))).toHaveLength(1);
      }
      expect(headerLabels).toHaveLength(expectedGroups.length);
    });

    it('collapses and expands an individual group', () => {
      const items = [
        buildItem(1, { folderId: 'folder-a' }),
        buildItem(2, { folderId: 'folder-a' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      });
      selectGroupingOption('By Root Folder');

      fireEvent.click(screen.getByRole('button', { name: 'Collapse group folder-a' }));
      expect(screen.queryByText('file1.txt')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tapestry-gallery')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Expand group folder-a' }));
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
      expect(screen.getByTestId('tapestry-gallery')).toBeInTheDocument();
    });

    it('clears collapsed groups when the grouping mode changes', () => {
      const items = [
        buildItem(1, { folderId: 'folder-a', path: 'src/file1.txt' }),
        buildItem(2, { folderId: 'folder-a', path: 'src/file2.txt' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'folder-a',
          path: `src/${key}.txt`,
        })),
      });
      selectGroupingOption('By Root Folder');
      fireEvent.click(screen.getByRole('button', { name: 'Collapse group folder-a' }));

      selectGroupingOption('By Directory');

      expect(screen.getByRole('button', { name: 'Collapse group folder-a/src' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expect(screen.getByText('file1.txt')).toBeInTheDocument();
    });

    it('selects, deselects, and reports partial selection for a group', () => {
      const items = [
        buildItem(1, { folderId: 'folder-a' }),
        buildItem(2, { folderId: 'folder-a' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      });
      selectGroupingOption('By Root Folder');

      const groupCheckbox = screen.getByLabelText('Select all items in group folder-a');
      fireEvent.click(groupCheckbox);
      expect(screen.getByLabelText('Select path/to/file1.txt')).toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).toBeChecked();

      fireEvent.click(groupCheckbox);
      expect(screen.getByLabelText('Select path/to/file1.txt')).not.toBeChecked();
      expect(screen.getByLabelText('Select path/to/file2.txt')).not.toBeChecked();

      fireEvent.click(screen.getByLabelText('Select path/to/file1.txt'));
      expect(groupCheckbox).toHaveAttribute('aria-checked', 'mixed');
    });

    it('hides group and page selection controls from view options and clears selection', () => {
      const items = [
        buildItem(1, { folderId: 'folder-a' }),
        buildItem(2, { folderId: 'folder-a' }),
      ];
      renderWithItems(items, {
        decodeFileSelection: vi.fn((key: string) => ({
          folderId: 'folder-a',
          path: `path/to/${key}.txt`,
        })),
      });
      selectGroupingOption('By Root Folder');
      fireEvent.click(screen.getByLabelText('Select path/to/file1.txt'));
      expect(screen.getByTestId('bulk-action-bar')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'View options' }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'File selection controls' }));

      expect(screen.queryByLabelText('Select all items in group folder-a')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Select all files on current page')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Select path/to/file1.txt')).not.toBeInTheDocument();
      expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
  });

  describe('scale and performance', () => {
    it('updates the gallery scale from the command dock', () => {
      render(<PreviewPanel {...baseProps} />);
      const gallery = screen.getByTestId('tapestry-gallery');
      const scale = screen.getByRole('slider', { name: 'Gallery scale' });

      fireEvent.change(scale, { target: { value: '8' } });

      expect(scale).toHaveValue('8');
      expect(gallery.style.gridTemplateColumns).toContain('256px');
    });

    it('renders only the current Tapestry page for a large dataset', () => {
      const items = Array.from({ length: 1000 }, (_, index) =>
        buildItem(index, { folderId: 'root' })
      );

      renderWithItems(items);

      expect(screen.getByTestId('page-info')).toHaveTextContent('of 42');
      expect(screen.getAllByTestId('tapestry-document-card')).toHaveLength(24);
      expect(screen.getByText('file0.txt')).toBeInTheDocument();
      expect(screen.queryByText('file24.txt')).not.toBeInTheDocument();
    });

    it('touches only the current selection while deferred rows still contain a large prior selection', () => {
      const staleItems = Array.from({ length: 1000 }, (_, index) =>
        buildItem(index, { folderId: 'root' })
      );
      const loadingFiles = new Set<string>();
      const loadingHasSpy = vi.spyOn(loadingFiles, 'has');
      const fileContents = { file2: 'content2', file999: 'content999' };
      mockUsePreviewPanelState.mockReturnValue(buildState(staleItems));
      const decodeFileSelection = (key: string) => ({
        folderId: key === 'file999' ? 'root-a' : 'root-z',
        path: `path/to/${key}.txt`,
      });

      const { rerender } = render(
        <PreviewPanel
          {...baseProps}
          decodeFileSelection={decodeFileSelection}
          fileContents={fileContents}
          loadingFiles={loadingFiles}
          selectedFiles={new Set(staleItems.map((item) => item.compositeKey))}
        />
      );

      // The first render populates the per-file cache from the large selection.
      // Keep those deferred rows while shrinking current membership to two files.
      loadingHasSpy.mockClear();
      const selectedFiles = new Set(['file999', 'file2']);
      rerender(
        <PreviewPanel
          {...baseProps}
          decodeFileSelection={decodeFileSelection}
          fileContents={fileContents}
          loadingFiles={loadingFiles}
          selectedFiles={selectedFiles}
        />
      );

      const loadingProbeKeys = loadingHasSpy.mock.calls.map(([compositeKey]) => compositeKey);

      // This is the actual no-N-scan regression instrumentation: base
      // derivation and cache persistence each probe every selected row once.
      expect(loadingProbeKeys).toHaveLength(selectedFiles.size * 2);
      expect(new Set(loadingProbeKeys)).toEqual(selectedFiles);
      for (const compositeKey of selectedFiles) {
        expect(loadingProbeKeys.filter((key) => key === compositeKey)).toHaveLength(2);
      }
      expect(
        screen
          .getAllByTestId('tapestry-document-card')
          .map((card) => within(card).getByText(/file\d+\.txt/).textContent)
      ).toEqual(['file999.txt', 'file2.txt']);
      // The context snapshot preserves deferred source order; the gallery above
      // independently applies its fixed root-folder ordering.
      expect(useWorkspaceContextCurationStore.getState().contextSnapshot?.files).toEqual([
        expect.objectContaining({ path: 'path/to/file2.txt' }),
        expect.objectContaining({ path: 'path/to/file999.txt' }),
      ]);
    });

    it('adds a dynamically selected file when its deferred row arrives', () => {
      const initialItems = [buildItem(1, { folderId: 'root' })];
      mockUsePreviewPanelState.mockReturnValue(buildState(initialItems));
      const { rerender } = render(
        <PreviewPanel
          {...baseProps}
          fileContents={{ file1: 'content1', file2: 'content2' }}
          selectedFiles={new Set(['file1'])}
        />
      );

      rerender(
        <PreviewPanel
          {...baseProps}
          fileContents={{ file1: 'content1', file2: 'content2' }}
          selectedFiles={new Set(['file1', 'file2'])}
        />
      );
      expect(screen.queryByText('file2.txt')).not.toBeInTheDocument();

      mockUsePreviewPanelState.mockReturnValue(
        buildState([buildItem(1, { folderId: 'root' }), buildItem(2, { folderId: 'root' })])
      );
      rerender(
        <PreviewPanel
          {...baseProps}
          fileContents={{ file1: 'content1', file2: 'content2' }}
          selectedFiles={new Set(['file1', 'file2'])}
        />
      );

      expect(screen.getByText('file2.txt')).toBeInTheDocument();
      expect(useWorkspaceContextCurationStore.getState().contextSnapshot?.files).toEqual([
        expect.objectContaining({ path: 'path/to/file1.txt' }),
        expect.objectContaining({ path: 'path/to/file2.txt' }),
      ]);
    });
  });
});
