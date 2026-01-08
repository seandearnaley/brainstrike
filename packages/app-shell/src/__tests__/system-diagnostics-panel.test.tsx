/**
 * Tests for SystemDiagnosticsPanel (BST-181)
 */

import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/preferences';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSystemDiagnosticsSettingsCategory,
  SystemDiagnosticsPanel,
} from '../diagnostics/system-diagnostics-panel';

// Mock QueueDiagnosticsPanel from vector-management
vi.mock('@brainstrike/vector-management', () => ({
  QueueDiagnosticsPanel: ({ showRefresh }: { showRefresh?: boolean }) => (
    <div data-show-refresh={showRefresh} data-testid="queue-diagnostics-panel">
      Queue Diagnostics Mock
    </div>
  ),
}));

describe('SystemDiagnosticsPanel', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  describe('rendering', () => {
    it('renders header with title and description', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
      expect(
        screen.getByText('Real-time health monitoring for database, queues, and workers')
      ).toBeInTheDocument();
    });

    it('renders refresh all button', () => {
      render(<SystemDiagnosticsPanel />);

      const refreshButton = screen.getByRole('button', { name: /refresh all diagnostics/i });
      expect(refreshButton).toBeInTheDocument();
    });

    it('renders database status section', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Database')).toBeInTheDocument();
      expect(screen.getByText('PGlite database connection')).toBeInTheDocument();
    });

    it('renders token cache worker section', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Token Cache Worker')).toBeInTheDocument();
      expect(screen.getByText('Token counting and indexing worker')).toBeInTheDocument();
    });

    it('renders queue diagnostics panel', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByTestId('queue-diagnostics-panel')).toBeInTheDocument();
    });
  });

  describe('database status', () => {
    it('shows loading state when database is connecting', () => {
      useDatabaseStatusStore.getState().setLoading();
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Connecting...')).toBeInTheDocument();
    });

    it('shows connected state with location', () => {
      useDatabaseStatusStore.getState().setConnected('In-Browser', '1 + 1 = 2');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('In-Browser')).toBeInTheDocument();
      expect(screen.getByText('1 + 1 = 2')).toBeInTheDocument();
      expect(screen.getByText('Database is operational')).toBeInTheDocument();
    });

    it('shows IPC location for Main Process', () => {
      useDatabaseStatusStore.getState().setConnected('Main Process', '42');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('IPC (Main Process)')).toBeInTheDocument();
    });

    it('shows disconnected state', () => {
      useDatabaseStatusStore.getState().setDisconnected('Unknown', 'Error');
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Disconnected')).toBeInTheDocument();
      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });
  });

  describe('token cache worker status', () => {
    it('shows not ready when token cache is not operational', () => {
      render(<SystemDiagnosticsPanel tokenCacheOperational={false} />);

      expect(screen.getByText('Not Ready')).toBeInTheDocument();
      expect(screen.getByText('Token counting worker is not running')).toBeInTheDocument();
    });

    it('shows memory only when operational but not persisted', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="memory"
          tokenCacheOperational={true}
          tokenCachePersisted={false}
        />
      );

      expect(screen.getByText('Memory Only')).toBeInTheDocument();
      expect(
        screen.getByText('Token counts are in-memory only (no persistence)')
      ).toBeInTheDocument();
    });

    it('shows fully operational when both operational and persisted', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="persistent"
          tokenCacheOperational={true}
          tokenCachePersisted={true}
        />
      );

      expect(screen.getByText('Fully Operational')).toBeInTheDocument();
      expect(screen.getByText('Token counts are saved to database')).toBeInTheDocument();
    });

    it('displays operational and persisted flags', () => {
      render(
        <SystemDiagnosticsPanel
          persistenceMode="persistent"
          tokenCacheOperational={true}
          tokenCachePersisted={true}
        />
      );

      // Find the worker section by looking for operational/persisted labels and values
      expect(screen.getByText('Operational')).toBeInTheDocument();
      expect(screen.getByText('Persisted')).toBeInTheDocument();
      expect(screen.getByText('Mode')).toBeInTheDocument();

      // Check that there are two "Yes" values displayed
      const yesElements = screen.getAllByText('Yes');
      expect(yesElements).toHaveLength(2);
    });
  });

  describe('refresh functionality', () => {
    it('clicking refresh all triggers component re-render', async () => {
      const user = userEvent.setup();
      render(<SystemDiagnosticsPanel />);

      const refreshButton = screen.getByRole('button', { name: /refresh all diagnostics/i });
      await user.click(refreshButton);

      // Button should be disabled briefly during refresh
      expect(refreshButton).toBeDisabled();

      // Wait for refresh to complete
      await vi.waitFor(() => {
        expect(refreshButton).not.toBeDisabled();
      });
    });

    it('passes showQueueRefresh prop to QueueDiagnosticsPanel', () => {
      render(<SystemDiagnosticsPanel showQueueRefresh={false} />);

      const queuePanel = screen.getByTestId('queue-diagnostics-panel');
      expect(queuePanel).toHaveAttribute('data-show-refresh', 'false');
    });
  });
});

describe('createSystemDiagnosticsSettingsCategory', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
  });

  it('returns a valid settings category', () => {
    const category = createSystemDiagnosticsSettingsCategory();

    expect(category.id).toBe('system-diagnostics');
    expect(category.title).toBe('System Diagnostics');
    expect(category.description).toBe('Monitor database, queue, and worker health in real-time.');
    expect(category.keywords).toContain('diagnostics');
    expect(category.keywords).toContain('health');
    expect(category.keywords).toContain('database');
    expect(category.icon).toBeDefined();
    expect(category.render).toBeInstanceOf(Function);
  });

  it('renders SystemDiagnosticsPanel when render is called', () => {
    const category = createSystemDiagnosticsSettingsCategory();
    render(category.render());

    expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
  });
});
