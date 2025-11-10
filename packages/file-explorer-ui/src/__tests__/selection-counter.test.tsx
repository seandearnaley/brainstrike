import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SelectionCounter } from '../selection-counter';
import { FileExplorerTestWrapper } from './test-helpers';

describe('SelectionCounter', () => {
  it('displays current selection count and max', () => {
    render(
      <FileExplorerTestWrapper>
        <SelectionCounter />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('selection-count')).toHaveTextContent('0');
    expect(screen.getByTestId('selection-max')).toBeInTheDocument();
  });

  it('uses secondary variant when under limit', () => {
    render(
      <FileExplorerTestWrapper>
        <SelectionCounter />
      </FileExplorerTestWrapper>
    );

    const badge = screen.getByTestId('selection-count').closest('.whitespace-nowrap');
    expect(badge).not.toHaveClass('destructive');
  });

  it('displays as output element for accessibility', () => {
    const { container } = render(
      <FileExplorerTestWrapper>
        <SelectionCounter />
      </FileExplorerTestWrapper>
    );

    const output = container.querySelector('output');
    expect(output).toBeInTheDocument();
  });

  it('renders with correct test ids', () => {
    render(
      <FileExplorerTestWrapper>
        <SelectionCounter />
      </FileExplorerTestWrapper>
    );

    expect(screen.getByTestId('selection-count')).toBeInTheDocument();
    expect(screen.getByTestId('selection-max')).toBeInTheDocument();
  });

  it('applies responsive text sizing classes', () => {
    const { container } = render(
      <FileExplorerTestWrapper>
        <SelectionCounter />
      </FileExplorerTestWrapper>
    );

    const badge = container.querySelector('.whitespace-nowrap');
    expect(badge).toHaveClass('text-xs');
    expect(badge).toHaveClass('sm:text-sm');
  });
});
