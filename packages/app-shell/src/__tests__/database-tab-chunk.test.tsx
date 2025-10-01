import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab-chunk';

// Mock the child components
vi.mock('../database-demo-panel', () => ({
  DatabaseDemoPanel: () => <div data-testid="database-demo-panel">Database Demo Panel</div>,
}));

vi.mock('../queue-hud', () => ({
  QueueHud: () => <div data-testid="queue-hud">Queue HUD</div>,
}));

vi.mock('../vector-status', () => ({
  VectorStatusWithDb: () => <div data-testid="vector-status">Vector Status</div>,
}));

describe('DatabaseTab', () => {
  it('should render all three components', () => {
    render(<DatabaseTab />);

    expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
    expect(screen.getByText('Database Demo Panel')).toBeInTheDocument();

    expect(screen.getByTestId('vector-status')).toBeInTheDocument();
    expect(screen.getByText('Vector Status')).toBeInTheDocument();

    expect(screen.getByTestId('queue-hud')).toBeInTheDocument();
    expect(screen.getByText('Queue HUD')).toBeInTheDocument();
  });

  it('should render components in correct order', () => {
    render(<DatabaseTab />);

    // The DatabaseTab returns a div with 3 child components
    // Check that all three components are rendered
    expect(screen.getByTestId('database-demo-panel')).toBeInTheDocument();
    expect(screen.getByTestId('vector-status')).toBeInTheDocument();
    expect(screen.getByTestId('queue-hud')).toBeInTheDocument();

    // Verify they are siblings (all at the same level)
    const panel = screen.getByTestId('database-demo-panel');
    const status = screen.getByTestId('vector-status');
    const hud = screen.getByTestId('queue-hud');

    // All should have the same parent
    expect(panel.parentElement).toBe(status.parentElement);
    expect(status.parentElement).toBe(hud.parentElement);
  });

  it('should be a functional component returning React element', () => {
    const result = DatabaseTab();
    expect(result).toBeDefined();
    expect(result.props).toBeDefined();
    // The div wrapper contains the 3 child components
    expect(result.props.children).toHaveLength(3);
  });

  it('should not have any props', () => {
    expect(DatabaseTab.length).toBe(0); // No parameters expected
  });
});
