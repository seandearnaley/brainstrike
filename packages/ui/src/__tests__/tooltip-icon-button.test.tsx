import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipIconButton } from '../assistant-ui-panel/tooltip-icon-button';
import { TooltipProvider } from '../tooltip';

const renderWithTooltip = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

describe('TooltipIconButton', () => {
  it('renders with children', () => {
    renderWithTooltip(
      <TooltipIconButton tooltip="Test tooltip">
        <span data-testid="icon">Icon</span>
      </TooltipIconButton>
    );

    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it('includes screen reader text with tooltip', () => {
    renderWithTooltip(
      <TooltipIconButton tooltip="Copy to clipboard">
        <span>Icon</span>
      </TooltipIconButton>
    );

    expect(screen.getByLabelText('Copy to clipboard')).toBeInTheDocument();
  });

  it('renders as a button by default', () => {
    renderWithTooltip(
      <TooltipIconButton tooltip="Test tooltip">
        <span>Icon</span>
      </TooltipIconButton>
    );

    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    renderWithTooltip(
      <TooltipIconButton className="custom-class" tooltip="Test tooltip">
        <span>Icon</span>
      </TooltipIconButton>
    );

    const button = screen.getByRole('button');
    expect(button).toHaveClass('custom-class');
  });

  it('passes additional props to button', () => {
    renderWithTooltip(
      <TooltipIconButton aria-label="Custom label" disabled tooltip="Test tooltip">
        <span>Icon</span>
      </TooltipIconButton>
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-label', 'Custom label');
  });

  it('uses default side of bottom for tooltip', () => {
    renderWithTooltip(
      <TooltipIconButton tooltip="Test tooltip">
        <span>Icon</span>
      </TooltipIconButton>
    );

    // The component should render without errors with default side
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('accepts different side positions', () => {
    const sides: Array<'top' | 'bottom' | 'left' | 'right'> = ['top', 'bottom', 'left', 'right'];

    for (const side of sides) {
      const { unmount } = renderWithTooltip(
        <TooltipIconButton side={side} tooltip="Test tooltip">
          <span>Icon</span>
        </TooltipIconButton>
      );

      expect(screen.getByRole('button')).toBeInTheDocument();
      unmount();
    }
  });

  it('renders with asChild prop', () => {
    renderWithTooltip(
      <TooltipIconButton asChild tooltip="Test tooltip">
        <a href="#test">Link Icon</a>
      </TooltipIconButton>
    );

    expect(screen.getByText('Link Icon')).toBeInTheDocument();
  });

  it('does not duplicate sr-only text when asChild is true', () => {
    renderWithTooltip(
      <TooltipIconButton asChild tooltip="Test tooltip">
        {/* biome-ignore lint/a11y/noAmbiguousAnchorText: test fixture asserting asChild composition, not real content */}
        <a href="#test">Link</a>
      </TooltipIconButton>
    );

    // When asChild is true, sr-only text should not be added
    const srOnlyElements = document.querySelectorAll('.sr-only');
    expect(srOnlyElements.length).toBe(0);
  });

  it('has correct default styles', () => {
    renderWithTooltip(
      <TooltipIconButton tooltip="Test tooltip">
        <span>Icon</span>
      </TooltipIconButton>
    );

    const button = screen.getByRole('button');
    expect(button).toHaveClass('size-6', 'p-1');
  });
});
