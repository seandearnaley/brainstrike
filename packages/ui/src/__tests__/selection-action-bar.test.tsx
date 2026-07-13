import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FolderInput } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SelectionAction, SelectionActionBar } from '../selection-action-bar';

describe('SelectionActionBar', () => {
  afterEach(cleanup);

  const actions: SelectionAction[] = [
    {
      compactLabel: 'Move',
      icon: <FolderInput aria-hidden="true" />,
      id: 'move',
      label: 'Move selected items',
      onAction: vi.fn(),
    },
  ];

  it('exposes a labeled toolbar and a polite selection status', () => {
    render(
      <SelectionActionBar
        actions={actions}
        onClear={vi.fn()}
        summary={
          <>
            <strong>3 selected</strong>
            <span> across two folders</span>
          </>
        }
      />
    );

    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 selected across two folders');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('runs generic actions without collection-specific arguments', () => {
    const onAction = vi.fn();

    render(
      <SelectionActionBar
        actions={[{ id: 'archive', label: 'Archive', onAction }]}
        onClear={vi.fn()}
        summary="2 selected"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith();
  });

  it('uses a named container to reveal compact labels without viewport breakpoints', () => {
    const { container } = render(
      <SelectionActionBar actions={actions} compact onClear={vi.fn()} summary="1 selected" />
    );

    const toolbar = screen.getByRole('toolbar');
    const label = screen.getByText('Move');

    expect(toolbar.className).toContain('@container/selection-actions');
    expect(label.className).toMatch(/@\[\d+px\]\/selection-actions:inline/);
    expect(container.querySelector('[style]')).toBeNull();
    expect(toolbar.className).toContain('shadow-lg');
  });

  it('keeps border and padding symmetric', () => {
    render(<SelectionActionBar actions={actions} onClear={vi.fn()} summary="1 selected" />);

    const toolbar = screen.getByRole('toolbar');
    expect(toolbar.className).toContain('border');
    expect(toolbar.className).toContain('p-2');
    expect(toolbar.className).not.toMatch(/\b(?:p[xy]|p[trbl])-\d/);
  });

  it('keeps summary detail visible and truncatable at narrow container widths', () => {
    render(
      <SelectionActionBar
        actions={actions}
        onClear={vi.fn()}
        summary="3 selected"
        summaryDetail="2 files, 1 chunk"
      />
    );

    const detail = screen.getByText('2 files, 1 chunk');
    expect(detail.className).toContain('truncate');
    expect(detail.className).not.toContain('hidden');
  });

  it('surfaces disabled reasons without running the action', () => {
    const onAction = vi.fn();

    render(
      <SelectionActionBar
        actions={[
          {
            disabled: true,
            disabledReason: 'Choose threads from one workspace',
            id: 'move',
            label: 'Move',
            onAction,
          },
        ]}
        onClear={vi.fn()}
        summary="2 selected"
      />
    );

    const button = screen.getByRole('button', { name: 'Move' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Choose threads from one workspace');
    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('uses the destructive button treatment when requested', () => {
    render(
      <SelectionActionBar
        actions={[
          {
            destructive: true,
            id: 'delete',
            label: 'Delete',
            onAction: vi.fn(),
          },
        ]}
        onClear={vi.fn()}
        summary="2 selected"
      />
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
      'data-variant',
      'destructive'
    );
  });

  it('clears selection from the explicit control or Escape within the toolbar', () => {
    const onClear = vi.fn();
    render(
      <SelectionActionBar
        actions={actions}
        clearButtonAriaLabel="Clear thread selection"
        clearButtonLabel="Clear threads"
        onClear={onClear}
        summary="2 selected"
      />
    );

    const clearButton = screen.getByRole('button', { name: 'Clear thread selection' });
    expect(clearButton).toHaveTextContent('Clear threads');
    fireEvent.click(clearButton);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move selected items' }), {
      key: 'Escape',
    });

    expect(onClear).toHaveBeenCalledTimes(2);
  });

  it('removes transitions when reduced motion is requested', () => {
    render(<SelectionActionBar actions={actions} onClear={vi.fn()} summary="1 selected" />);

    expect(screen.getByRole('toolbar').className).toContain('motion-reduce:transition-none');
  });
});
