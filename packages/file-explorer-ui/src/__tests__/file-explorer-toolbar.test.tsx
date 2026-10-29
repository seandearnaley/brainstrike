import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { FileExplorerStrings } from '@brainstrike/types';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerToolbar } from '../shell/file-explorer-toolbar';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

function getProps(overrides: Partial<React.ComponentProps<typeof FileExplorerToolbar>> = {}) {
  return {
    bulkSelectionControl: <button type="button">Select all files</button>,
    isLoading: false,
    onDirectorySelect: vi.fn().mockResolvedValue(undefined),
    selectionStatusControl: <output>0 of 10 selected</output>,
    ...overrides,
  };
}

describe('FileExplorerToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one Add Folder action alongside the selection controls', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toBeInTheDocument();
    // Multi-root: the label no longer flips between "Select Root" and "Add Folder".
    expect(screen.queryByText('Select Root')).not.toBeInTheDocument();
    expect(screen.queryByText('Add Folder')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select all files' })).toBeInTheDocument();
    expect(screen.getByText('0 of 10 selected')).toBeInTheDocument();
  });

  it('orders selection status left, Add Folder centered, and bulk selection right', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);

    const toolbar = screen.getByTestId('file-explorer-toolbar');
    const [leftSlot, centerSlot, rightSlot] = Array.from(toolbar.children);
    const selectionStatus = screen.getByText('0 of 10 selected');
    const addFolderButton = screen.getByRole('button', {
      name: FileExplorerStrings.addFolderToWorkspace,
    });
    const bulkSelectionButton = screen.getByRole('button', { name: 'Select all files' });

    expect(leftSlot).toContainElement(selectionStatus);
    expect(leftSlot).toHaveClass('justify-start');
    expect(centerSlot).toBe(addFolderButton);
    expect(rightSlot).toContainElement(bulkSelectionButton);
    expect(rightSlot).toHaveClass('justify-end');
  });

  it('keeps the edge action last and swaps full actions for a compact menu at narrow widths', () => {
    renderWithProviders(
      <FileExplorerToolbar
        {...getProps({
          columnsControl: <button type="button">Columns</button>,
          compactActionsControl: <button type="button">More Explorer actions</button>,
          filtersControl: <button type="button">View filters</button>,
          treeActionsControl: <button type="button">Refresh</button>,
        })}
      />
    );

    const toolbar = screen.getByTestId('file-explorer-toolbar');
    const rightCluster = toolbar.children.item(2)?.firstElementChild;
    expect(rightCluster).not.toBeNull();
    const [columnsSlot, treeActions, fullActions, compactActions, edgeAction] = Array.from(
      rightCluster?.children ?? []
    );
    // Columns joins one breakpoint LATER (BST-1208): at 236px the right track
    // holds exactly three 28px controls, so a fourth would break the geometry.
    expect(columnsSlot).toContainElement(screen.getByRole('button', { name: 'Columns' }));
    expect(columnsSlot).toHaveClass('hidden', '@[300px]/explorer-toolbar:contents');
    // Tree actions sit OUTSIDE the narrow-hidden wrapper (BST-657): the cluster
    // carries the scanning indicator's Cancel, the only abort path for a
    // running sweep. Only View Filters is width-gated here.
    expect(treeActions).toBe(screen.getByRole('button', { name: 'Refresh' }));
    expect(fullActions).toContainElement(screen.getByRole('button', { name: 'View filters' }));
    expect(fullActions).toHaveClass('hidden', '@[236px]/explorer-toolbar:contents');
    expect(compactActions).toBe(screen.getByRole('button', { name: 'More Explorer actions' }));
    expect(edgeAction).toBe(screen.getByRole('button', { name: 'Select all files' }));
    expect(rightCluster).toHaveClass('gap-0', '@[236px]/explorer-toolbar:gap-1');
  });

  it('renders tree actions outside the narrow-hidden wrapper so an in-flight operation stays cancellable (BST-657)', () => {
    // #1916 wrapped treeActionsControl in the `@[236px]:contents hidden` block
    // together with the view-filters toggle. That block also carries the inline
    // scanning indicator's Cancel (X) -- the ONLY way to abort a running
    // expand-all sweep, since Refresh is disabled while one runs and the
    // compact menu never offered a cancel. At the 180px minimum panel width the
    // whole cluster was display:none, so a desktop user had no abort at all.
    // Tree actions must therefore sit in the ungated track; the cluster's own
    // container queries decide which of its children collapse.
    renderWithProviders(
      <FileExplorerToolbar
        {...getProps({
          filtersControl: <button type="button">View filters</button>,
          treeActionsControl: <button type="button">Refresh</button>,
        })}
      />
    );

    // Scoped to the RIGHT cluster: BST-1208 added a second narrow-hidden
    // wrapper in the LEFT track for Expand/Collapse, so an unscoped query now
    // finds that one first. The contract under test is unchanged — tree actions
    // must not be inside the right cluster's width-gated wrapper.
    const rightCluster = screen.getByTestId('file-explorer-toolbar').children.item(2);
    const narrowHiddenWrapper = rightCluster?.querySelector(
      '.\\@\\[236px\\]\\/explorer-toolbar\\:contents'
    );
    expect(narrowHiddenWrapper).not.toBeNull();
    expect(narrowHiddenWrapper).toContainElement(
      screen.getByRole('button', { name: 'View filters' })
    );
    expect(narrowHiddenWrapper).not.toContainElement(
      screen.getByRole('button', { name: 'Refresh' })
    );
  });

  it('preserves the data-testid that desktop E2E depends on', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    expect(screen.getByTestId('select-root-button')).toBeInTheDocument();
  });

  it('disables the action button while loading', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps({ isLoading: true })} />);
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toBeDisabled();
  });

  it('invokes onDirectorySelect when the action button is clicked', async () => {
    const props = getProps();
    const user = userEvent.setup();
    renderWithProviders(<FileExplorerToolbar {...props} />);
    await user.click(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    );
    expect(props.onDirectorySelect).toHaveBeenCalledTimes(1);
  });

  it('does not render the focused-root folder badge (removed for multi-root)', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    const toolbar = screen.getByTestId('file-explorer-toolbar');
    expect(toolbar).not.toHaveTextContent(/focused root/iu);
  });

  it('uses a stable 36px centered toolbar and an accented reduced-motion-safe primary action', () => {
    renderWithProviders(<FileExplorerToolbar {...getProps()} />);
    const toolbar = screen.getByTestId('file-explorer-toolbar');

    expect(toolbar.parentElement).toHaveClass(
      '@container/explorer-toolbar',
      'h-9',
      'overflow-hidden',
      'border-b'
    );
    expect(toolbar).toHaveClass('h-full', 'grid', 'gap-0');
    expect(toolbar).not.toHaveClass('@[96px]/explorer-toolbar:gap-0.5');
    const [leftSlot, , rightSlot] = Array.from(toolbar.children);
    expect(leftSlot).toHaveClass('@container/explorer-selection');
    expect(rightSlot).toHaveClass('@container/explorer-bulk');
    expect(leftSlot?.firstElementChild).toHaveClass(
      'pl-1',
      '@[96px]/explorer-toolbar:pl-1.5',
      '@[128px]/explorer-toolbar:pl-3'
    );
    expect(rightSlot?.firstElementChild).toHaveClass(
      'pr-1',
      '@[96px]/explorer-toolbar:pr-1.5',
      '@[128px]/explorer-toolbar:pr-3'
    );
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toHaveClass(
      'border-primary/40',
      'bg-primary/10',
      'motion-reduce:transition-none',
      'size-6',
      '@[96px]/explorer-toolbar:size-7'
    );
    // Controls cap at size-7 inside the 36px bar — the old size-8 tier is gone.
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).not.toHaveClass('@[128px]/explorer-toolbar:size-8');
    expect(
      screen.getByRole('button', { name: FileExplorerStrings.addFolderToWorkspace })
    ).toHaveAttribute('data-size', 'icon-xs');
  });
});
