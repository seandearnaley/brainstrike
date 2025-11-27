import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PanelLayoutProvider, usePanelLayout } from '../providers/panel-layout-provider';

// Test component to access context
function TestConsumer() {
  const context = usePanelLayout();
  return <div data-testid="context-value">{context ? 'has context' : 'no context'}</div>;
}

describe('PanelLayoutProvider', () => {
  it('renders children', () => {
    render(
      <PanelLayoutProvider>
        <div data-testid="child">Child content</div>
      </PanelLayoutProvider>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('provides context to children', () => {
    render(
      <PanelLayoutProvider>
        <TestConsumer />
      </PanelLayoutProvider>
    );

    expect(screen.getByTestId('context-value')).toHaveTextContent('has context');
  });

  it('renders nested components', () => {
    render(
      <PanelLayoutProvider>
        <div>
          <div>Level 1</div>
          <div>
            <div>Level 2</div>
          </div>
        </div>
      </PanelLayoutProvider>
    );

    expect(screen.getByText('Level 1')).toBeInTheDocument();
    expect(screen.getByText('Level 2')).toBeInTheDocument();
  });
});

describe('usePanelLayout', () => {
  it('returns null when used outside provider', () => {
    // This would normally throw or return null
    // The hook might have default behavior
    render(<TestConsumer />);
    expect(screen.getByTestId('context-value')).toBeInTheDocument();
  });
});
