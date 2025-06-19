import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { encodeFileSelection } from '@brainstrike/utils';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: vi.fn(),
}));

import { useFileExplorerStoreContext } from '../file-explorer-provider';
import OptimizedFileTreeRow from '../optimized-file-tree-row';

function createStore(overrides: Partial<Record<string, unknown>> = {}) {
  const state = {
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: 5,
    addMultipleSelectedFiles: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
    ...overrides,
  };
  const store = vi.fn((selector: (s: typeof state) => unknown) => selector(state));
  Object.assign(store, { getState: () => state });
  return store as unknown as ReturnType<typeof useFileExplorerStoreContext>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const baseFileProps = {
  node: createFileNode({ name: 'file.ts', path: '/file.ts' }),
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'root',
};

const baseDirNode = createDirectoryNode({
  name: 'dir',
  path: '/dir',
  children: [
    createFileNode({ name: 'a.ts', path: '/dir/a.ts' }),
    createFileNode({ name: 'b.ts', path: '/dir/b.ts' }),
  ],
});

const baseDirProps = {
  node: baseDirNode,
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'root',
};

it('memoizes renders when props are unchanged', () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { rerender } = render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(store).toHaveBeenCalledTimes(1);

  rerender(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(store).toHaveBeenCalledTimes(1);

  rerender(<OptimizedFileTreeRow {...baseFileProps} isExpanded />);
  expect(store).toHaveBeenCalledTimes(2);
});

it('triggers directory expansion callback', async () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<OptimizedFileTreeRow {...baseDirProps} onToggleDirectoryExpansion={onToggle} />);

  const button = screen.getByTestId('expand-collapse-button');
  await user.click(button);

  expect(onToggle).toHaveBeenCalledWith('/dir');
});

it('shows correct checkbox states for directory selection', () => {
  const selected = new Set([
    encodeFileSelection('root', '/dir/a.ts'),
    encodeFileSelection('root', '/dir/b.ts'),
  ]);
  const store = createStore({ selectedFilePaths: selected });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { unmount } = render(<OptimizedFileTreeRow {...baseDirProps} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Select dir' });
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveAttribute('data-state', 'checked');
  unmount();

  const partial = new Set([encodeFileSelection('root', '/dir/a.ts')]);
  const store2 = createStore({ selectedFilePaths: partial });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store2);
  render(<OptimizedFileTreeRow {...baseDirProps} />);
  const checkbox2 = screen.getByRole('checkbox', { name: 'Select dir' });
  expect(checkbox2).toHaveAttribute('data-state', 'indeterminate');
});

it('disables checkbox when selection limit is reached', async () => {
  const selected = new Set([
    encodeFileSelection('root', '/x.ts'),
    encodeFileSelection('root', '/y.ts'),
  ]);
  const onToggle = vi.fn();
  const store = createStore({
    selectedFilePaths: selected,
    maxSelectionCount: 2,
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();

  render(<OptimizedFileTreeRow {...baseFileProps} onToggleFileSelection={onToggle} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Select file.ts' });
  expect(checkbox).toBeDisabled();
  await user.click(checkbox);
  expect(onToggle).not.toHaveBeenCalled();
});

it('renders loader and icon states correctly', () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { rerender } = render(<OptimizedFileTreeRow {...baseFileProps} isLoading />);
  expect(screen.getByLabelText('Loading file.ts')).toBeInTheDocument();

  rerender(<OptimizedFileTreeRow {...baseFileProps} isLoading={false} />);
  expect(screen.queryByLabelText('Loading file.ts')).not.toBeInTheDocument();

  rerender(<OptimizedFileTreeRow {...baseDirProps} isExpanded={true} isLoading={false} />);
  expect(screen.getByRole('button', { name: /collapse dir directory/i })).toBeInTheDocument();
});
