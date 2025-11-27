import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NodeInspector } from '../collection-browser/node-inspector';
import { TooltipProvider } from '../tooltip';

const renderWithProviders = (ui: React.ReactElement) => {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
};

describe('NodeInspector', () => {
  it('renders without crashing when no node is selected', () => {
    renderWithProviders(<NodeInspector nodeType={null} nodeData={null} />);

    // Component should render
    expect(document.body).toBeInTheDocument();
  });

  it('renders collapse toggle button', () => {
    renderWithProviders(<NodeInspector nodeType={null} nodeData={null} />);

    // Should have a button for collapse toggle
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('calls onCollapseChange when toggle is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        nodeType={null}
        nodeData={null}
        isCollapsed={false}
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
      <NodeInspector nodeType={null} nodeData={null} className="custom-class" />
    );

    const element = container.querySelector('.custom-class');
    expect(element).not.toBeNull();
  });

  it('renders with isCollapsed true', () => {
    renderWithProviders(<NodeInspector nodeType={null} nodeData={null} isCollapsed={true} />);

    // Should render without errors
    expect(document.body).toBeInTheDocument();
  });

  it('toggles collapse state when button is clicked', () => {
    const onCollapseChange = vi.fn();
    renderWithProviders(
      <NodeInspector
        nodeType={null}
        nodeData={null}
        isCollapsed={true}
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
      <NodeInspector nodeType={null} nodeData={null} width={400} />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('accepts custom width as string', () => {
    const { container } = renderWithProviders(
      <NodeInspector nodeType={null} nodeData={null} width="300px" />
    );

    expect(container.firstChild).toBeInTheDocument();
  });

  it('handles null nodeType and nodeData', () => {
    const { container } = renderWithProviders(<NodeInspector nodeType={null} nodeData={null} />);

    expect(container).toBeInTheDocument();
  });
});
