import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileExplorerSelectionActions } from '../file-explorer-selection-actions';

describe('FileExplorerSelectionActions', () => {
  afterEach(cleanup);

  it('stays out of the tree entirely while nothing is selected', () => {
    const { container } = render(
      <FileExplorerSelectionActions
        onClear={vi.fn()}
        selectedCount={0}
        trailingContent={<button type="button">Import into collection…</button>}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('floats the bar over the tree without intercepting pointer input', () => {
    render(<FileExplorerSelectionActions onClear={vi.fn()} selectedCount={3} />);

    const overlay = screen.getByTestId('selection-action-overlay');
    expect(overlay).toHaveClass('absolute', 'bottom-3', 'pointer-events-none');
    expect(screen.getByRole('toolbar', { name: 'File selection actions' })).toHaveClass(
      'pointer-events-auto'
    );
  });

  it('summarizes the selection and pluralizes the count', () => {
    const { rerender } = render(
      <FileExplorerSelectionActions onClear={vi.fn()} selectedCount={1} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 file selected');

    rerender(<FileExplorerSelectionActions onClear={vi.fn()} selectedCount={1234} />);
    expect(screen.getByRole('status')).toHaveTextContent('1,234 files selected');
  });

  it('clears the selection through the explicit control', () => {
    const onClear = vi.fn();
    render(<FileExplorerSelectionActions onClear={onClear} selectedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear file selection' }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it('hosts injected selection actions inside the bar', () => {
    render(
      <FileExplorerSelectionActions
        onClear={vi.fn()}
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
      <FileExplorerSelectionActions
        onClear={vi.fn()}
        selectedCount={2}
        trailingContent={<button type="button">Import into collection…</button>}
      />
    );

    expect(screen.getByTestId('explorer-selection-actions')).toHaveClass('relative');
  });
});
