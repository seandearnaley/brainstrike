import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileExplorerSelectionActions,
  useSelectionActionBarPin,
} from '../file-explorer-selection-actions';

/** Mirrors how FileExplorerPanel hosts the bar. */
function BarHost({
  onClear = vi.fn(),
  selectedCount,
  trailingContent,
}: {
  onClear?: () => void;
  selectedCount: number;
  trailingContent?: ReactNode;
}) {
  return (
    <FileExplorerSelectionActions
      onClear={onClear}
      selectedCount={selectedCount}
      trailingContent={trailingContent}
    />
  );
}

/** Stand-in for ExplorerImportAction: pins while it has work in flight. */
function PinningAction({ busy }: { busy: boolean }) {
  useSelectionActionBarPin(busy);
  return (
    <button data-testid="pinning-action" type="button">
      Import into collection…
    </button>
  );
}

describe('FileExplorerSelectionActions', () => {
  afterEach(cleanup);

  it('stays out of the tree entirely while nothing is selected', () => {
    const { container } = render(
      <BarHost
        selectedCount={0}
        trailingContent={<button type="button">Import into collection…</button>}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('floats the bar over the tree without intercepting pointer input', () => {
    render(<BarHost selectedCount={3} />);

    const overlay = screen.getByTestId('selection-action-overlay');
    expect(overlay).toHaveClass('absolute', 'bottom-3', 'pointer-events-none');
    expect(screen.getByRole('toolbar', { name: 'File selection actions' })).toHaveClass(
      'pointer-events-auto'
    );
  });

  it('summarizes the selection and pluralizes the count', () => {
    const { rerender } = render(<BarHost selectedCount={1} />);
    expect(screen.getByRole('status')).toHaveTextContent('1 file selected');

    rerender(<BarHost selectedCount={1234} />);
    expect(screen.getByRole('status')).toHaveTextContent('1,234 files selected');
  });

  it('clears the selection through the explicit control', () => {
    const onClear = vi.fn();
    render(<BarHost onClear={onClear} selectedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear file selection' }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('hosts injected selection actions inside the bar', () => {
    render(
      <BarHost
        selectedCount={2}
        trailingContent={<button type="button">Import into collection…</button>}
      />
    );

    const toolbar = screen.getByRole('toolbar', { name: 'File selection actions' });
    expect(
      screen.getByRole('button', { name: 'Import into collection…' }).closest('[role="toolbar"]')
    ).toBe(toolbar);
  });

  it('gives injected transient panels a positioned ancestor to anchor against', () => {
    render(
      <BarHost
        selectedCount={2}
        trailingContent={<button type="button">Import into collection…</button>}
      />
    );

    expect(screen.getByTestId('explorer-selection-actions')).toHaveClass('relative');
  });

  it('drops an unpinned action as soon as the selection empties', () => {
    const { rerender } = render(
      <BarHost selectedCount={2} trailingContent={<PinningAction busy={false} />} />
    );
    expect(screen.getByTestId('pinning-action')).toBeInTheDocument();

    rerender(<BarHost selectedCount={0} trailingContent={<PinningAction busy={false} />} />);

    expect(screen.queryByTestId('explorer-selection-actions')).not.toBeInTheDocument();
  });

  it('keeps a pinned action mounted after the selection empties', () => {
    const { rerender } = render(
      <BarHost selectedCount={2} trailingContent={<PinningAction busy />} />
    );
    expect(screen.getByTestId('pinning-action')).toBeInTheDocument();

    rerender(<BarHost selectedCount={0} trailingContent={<PinningAction busy />} />);

    // The bar — and therefore the injected action's whole subtree, including
    // any long-running service it owns — survives the selection drop.
    expect(screen.getByTestId('explorer-selection-actions')).toBeInTheDocument();
    expect(screen.getByTestId('pinning-action')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('0 files selected');
  });

  it('releases the bar once the pinned action finishes at zero selection', () => {
    const { rerender } = render(
      <BarHost selectedCount={2} trailingContent={<PinningAction busy />} />
    );
    rerender(<BarHost selectedCount={0} trailingContent={<PinningAction busy />} />);
    expect(screen.getByTestId('explorer-selection-actions')).toBeInTheDocument();

    rerender(<BarHost selectedCount={0} trailingContent={<PinningAction busy={false} />} />);

    expect(screen.queryByTestId('explorer-selection-actions')).not.toBeInTheDocument();
  });
});
