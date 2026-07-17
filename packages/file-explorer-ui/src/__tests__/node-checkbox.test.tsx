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
    depth: 0,
    handle: {} as FileSystemFileHandle,
    isVisible: true,
    name: 'test.txt',
    path: '/test.txt',
    rootFolderId: 'root',
    selectionState: 'unchecked',
    type: 'file',
  };

  const mockOnSelect = vi.fn();

  beforeEach(() => {
    mockOnSelect.mockClear();
  });

  it('renders checkbox with correct label', () => {
    render(
      <NodeCheckboxWrapper
        checked={false}
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeInTheDocument();
  });

  it('renders checked state correctly', () => {
    render(
      <NodeCheckboxWrapper
        checked={true}
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeChecked();
  });

  it('renders indeterminate state correctly', () => {
    render(
      <NodeCheckboxWrapper
        checked="indeterminate"
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeInTheDocument();
  });

  it('calls onSelect when clicked and not disabled', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        checked={false}
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
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
        checked={false}
        disabled={true}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
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
        checked={false}
        disabled={true}
        maxSelectionCount={50}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={true}
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
        checked={false}
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    expect(screen.queryByText(/Cannot select more than/)).not.toBeInTheDocument();
  });

  it('stops propagation on click', async () => {
    const user = userEvent.setup();
    const parentClickHandler = vi.fn();
    const parentKeyHandler: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        parentClickHandler(event);
      }
    };

    render(
      // biome-ignore lint/a11y/useSemanticElements: test harness avoids nested buttons.
      <div
        data-testid="selection-wrapper"
        onClick={parentClickHandler}
        onKeyDown={parentKeyHandler}
        role="button"
        tabIndex={0}
      >
        <NodeCheckboxWrapper
          checked={false}
          disabled={false}
          maxSelectionCount={100}
          node={mockNode}
          onSelect={mockOnSelect}
          wouldExceedLimit={false}
        />
      </div>
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    await user.click(checkbox);

    expect(mockOnSelect).toHaveBeenCalled();
    expect(parentClickHandler).not.toHaveBeenCalled();
  });

  it('renders with correct id attribute', () => {
    render(
      <NodeCheckboxWrapper
        checked={false}
        disabled={false}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toHaveAttribute('id', '/test.txt');
  });

  it('handles different maxSelectionCount values in tooltip', async () => {
    const user = userEvent.setup();

    render(
      <NodeCheckboxWrapper
        checked={false}
        disabled={true}
        maxSelectionCount={1000}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={true}
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
        checked={false}
        disabled={true}
        maxSelectionCount={100}
        node={mockNode}
        onSelect={mockOnSelect}
        wouldExceedLimit={false}
      />
    );

    const checkbox = screen.getByLabelText('Select test.txt');
    expect(checkbox).toBeDisabled();
  });
});
