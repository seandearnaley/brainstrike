import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from '../collection-browser/node-inspector';
import { TooltipProvider } from '../tooltip';

const renderWithProviders = (ui: React.ReactElement) =>
  render(ui, {
    wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
  });

describe('NodeInspector', () => {
  it('renders without crashing when no node is selected', () => {
    renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    // Component should render
    expect(document.body).toBeInTheDocument();
  });

  it('renders collapse toggle button', () => {
    renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    // Should have a button for collapse toggle
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('calls onCollapseChange when toggle is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        isCollapsed={false}
        nodeData={null}
        nodeType={null}
        onCollapseChange={onCollapseChange}
      />
    );

    const buttons = screen.getAllByRole('button');
    if (buttons.length > 0 && buttons[0]) {
      fireEvent.click(buttons[0]);
      expect(onCollapseChange).toHaveBeenCalled();
    }
  });

  it('applies custom className', () => {
    const { container } = renderWithProviders(
      <NodeInspector className="custom-class" nodeData={null} nodeType={null} />
    );

    const element = container.querySelector('.custom-class');
    expect(element).not.toBeNull();
  });

  it('renders with isCollapsed true', () => {
    renderWithProviders(<NodeInspector isCollapsed={true} nodeData={null} nodeType={null} />);

    // Should render without errors
    expect(document.body).toBeInTheDocument();
  });

  it('reflects expanded state via aria-expanded on the collapse toggle', () => {
    const { rerender } = renderWithProviders(
      <NodeInspector isCollapsed={false} nodeData={null} nodeType={null} />
    );
    expect(screen.getByRole('button', { name: 'Collapse inspector' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    rerender(<NodeInspector isCollapsed={true} nodeData={null} nodeType={null} />);
    expect(screen.getByRole('button', { name: 'Expand inspector' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('toggles collapse state when button is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        isCollapsed={true}
        nodeData={null}
        nodeType={null}
        onCollapseChange={onCollapseChange}
      />
    );

    const buttons = screen.getAllByRole('button');
    if (buttons.length > 0 && buttons[0]) {
      fireEvent.click(buttons[0]);
      expect(onCollapseChange).toHaveBeenCalledWith(false);
    }
  });

  it('accepts custom width as number', () => {
    const { container } = renderWithProviders(
      <NodeInspector nodeData={null} nodeType={null} width={400} />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('accepts custom width as string', () => {
    const { container } = renderWithProviders(
      <NodeInspector nodeData={null} nodeType={null} width="300px" />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('handles null nodeType and nodeData', () => {
    const { container } = renderWithProviders(<NodeInspector nodeData={null} nodeType={null} />);

    expect(container).toBeInTheDocument();
  });
});
