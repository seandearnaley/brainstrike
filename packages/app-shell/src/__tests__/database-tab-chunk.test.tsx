import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseTab } from '../database-tab-chunk';

// Mock dependencies
vi.mock('@brainstrike/db-explorer', () => ({
  DatabaseDemoPanel: () => <div data-testid="database-demo-panel">DatabaseDemoPanel</div>,
}));

vi.mock('@brainstrike/vector-management', () => ({
  VectorStatusWithDb: () => <div data-testid="vector-status-with-db">VectorStatusWithDb</div>,
  QueueHud: () => <div data-testid="queue-hud">QueueHud</div>,
}));

describe('DatabaseTab (chunk)', () => {
  it('renders DatabaseDemoPanel, VectorStatusWithDb, and QueueHud', () => {
    const { getByTestId } = render(<DatabaseTab />);

    expect(getByTestId('database-demo-panel')).toBeInTheDocument();
    expect(getByTestId('vector-status-with-db')).toBeInTheDocument();
    expect(getByTestId('queue-hud')).toBeInTheDocument();
  });

  it('uses VectorStatusWithDb (not VectorStatus) to show actual database status', () => {
    const { getByTestId, queryByTestId } = render(<DatabaseTab />);

    // Should render VectorStatusWithDb (with database access)
    expect(getByTestId('vector-status-with-db')).toBeInTheDocument();

    // Should NOT render the simplified VectorStatus component
    // This prevents regression where VectorStatus always shows "pgvector: off"
    expect(queryByTestId('vector-status')).not.toBeInTheDocument();
  });
});
