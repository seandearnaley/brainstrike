import type { IFileNode } from '@brainstrike/types';
import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NodeCheckbox } from '../node-checkbox';

function NodeCheckboxWrapper(props: React.ComponentProps<typeof NodeCheckbox>) {
  return (
    <TooltipProvider>
      <NodeCheckbox {...props} />
    </TooltipProvider>
  );
}

describe('NodeCheckbox', () => {
  const mockNode: IFileNode = {
    name: 'test.txt',
    path: '/test.txt',
    type: 'file',
    isVisible: true,
    handle: {} as FileSystemFileHandle,
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: 'root',
  };

  const mockOnSelect = vi.fn();

  beforeEach(() => {
    mockOnSelect.mockClear();
  });

  it('renders checkbox with correct label', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeInTheDocument();
  });

  it('renders checked state correctly', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={true}
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeChecked();
  });

  it('renders indeterminate state correctly', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked="indeterminate"
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeInTheDocument();
  });

  it('calls onSelect when clicked and not disabled', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.click(checkbox);

    expect(mockOnSelect).toHaveBeenCalledTimes(1);
  });

  it('does not call onSelect when disabled', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={true}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.click(checkbox);

    expect(mockOnSelect).not.toHaveBeenCalled();
  });

  it('shows tooltip when would exceed limit', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={true}
        onSelect={mockOnSelect}
        wouldExceedLimit={true}
        maxSelectionCount={50}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.hover(checkbox);

    const tooltips = await screen.findAllByText('Cannot select more than 50 files');
    expect(tooltips[0]).toBeInTheDocument();
  });

  it('does not show tooltip when would not exceed limit', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    expect(screen.queryByText(/Cannot select more than/)).not.toBeInTheDocument();
  });

  it('stops propagation on click', async () => {
    const user = userEvent.setup();
    const parentClickHandler = vi.fn();

    render(
      <button
        type="button"
        onClick={parentClickHandler}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') parentClickHandler();
        }}
      >
        <NodeCheckboxWrapper
          node={mockNode}
          checked={false}
          disabled={false}
          onSelect={mockOnSelect}
          wouldExceedLimit={false}
          maxSelectionCount={100}
        />
      </button>
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.click(checkbox);

    expect(mockOnSelect).toHaveBeenCalled();
    expect(parentClickHandler).not.toHaveBeenCalled();
  });

  it('renders with correct id attribute', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={false}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toHaveAttribute('id', '/test.txt');
  });

  it('handles different maxSelectionCount values in tooltip', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={true}
        onSelect={mockOnSelect}
        wouldExceedLimit={true}
        maxSelectionCount={1000}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.hover(checkbox);

    const tooltips = await screen.findAllByText('Cannot select more than 1000 files');
    expect(tooltips[0]).toBeInTheDocument();
  });

  it('renders checkbox with disabled state', () => {
    render(
      <NodeCheckboxWrapper
        node={mockNode}
        checked={false}
        disabled={true}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
        maxSelectionCount={100}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeDisabled();
  });
});
