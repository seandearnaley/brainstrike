/**
 * Tests for SystemDiagnosticsPanel (BST-181)
 */

import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/preferences/stores/database-status-store';
import { render, screen, waitFor } from '@testing-library/react';
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

// Mock the optional token cache context hook
const mockUseOptionalTokenCacheContext = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => mockUseOptionalTokenCacheContext(),
}));

describe('SystemDiagnosticsPanel', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
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
      expect(screen.getByText('Local database connection')).toBeInTheDocument();
      expect(screen.queryByText('PGlite database connection')).not.toBeInTheDocument();
    });

    it('renders token cache worker section', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Token Cache Worker')).toBeInTheDocument();
      expect(screen.getByText('Token counting and indexing worker')).toBeInTheDocument();
    });

    it('renders queue diagnostics panel', () => {
      render(<SystemDiagnosticsPanel />);

      return waitFor(() => {
        expect(screen.getByTestId('queue-diagnostics-panel')).toBeInTheDocument();
      });
    });

    it('renders desktop platform diagnostics when the desktop bridge is available', async () => {
      (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
        getSnapshot: vi.fn(async () => ({
          collectedAt: '2026-05-20T00:00:00.000Z',
          crashRecovery: {
            lastRendererCrashAt: '2026-05-20T00:01:00.000Z',
            lastRendererCrashExitCode: 5,
            lastRendererCrashReason: 'crashed',
            lastRendererCrashWindowRole: 'visible-ui',
            lastRendererReloadAt: null,
            lastRendererReloadWindowRole: null,
            pendingRendererRecovery: true,
            rendererCrashCount: 1,
            rendererReloadAttemptCount: 0,
            suppressedRendererReloadCount: 0,
          },
          embeddingHost: {
            active: false,
            lastError: null,
            pendingRequestCount: 0,
            runtimeId: 'embedding-host:idle',
            runtimeKind: 'embedding-host',
            sourceState: 'running',
            state: 'idle',
          },
          llmHost: {
            active: true,
            lastError: null,
            pendingRequestCount: 1,
            runtimeId: 'llm-host:active',
            runtimeKind: 'llm-host',
            sourceState: 'running',
            state: 'active',
          },
          indexing: {
            activeBackfills: [
              {
                embeddingSetId: 'set-1',
                progress: { current: 2, total: 4 },
                requestId: 'background-indexing-backfill:set-1',
                source: 'background-indexing',
              },
            ],
            databaseWork: {
              runningLabel: 'background-indexing-backfill',
              runningPriority: 'background',
            },
            dimensionIndexMaintenance: {
              maintenance: [
                {
                  attempts: 1,
                  completedAt: null,
                  dimension: 384,
                  lastDurationMs: null,
                  lastError: null,
                  lastForegroundProbeMaxMs: null,
                  lastForegroundProbeP95Ms: null,
                  lastInvalidIndexName: null,
                  nextRunAt: '2026-05-20T00:02:00.000Z',
                  reason: 'embedding-backfill:set-1',
                  requestedAt: '2026-05-20T00:01:00.000Z',
                  startedAt: null,
                  state: 'pending',
                  strategy: 'regular',
                },
              ],
              suspensions: [
                {
                  dimension: 384,
                  reason: 'nonblocking-background-indexing',
                  suspendedAt: '2026-05-20T00:00:59.000Z',
                },
              ],
            },
          },
          migration: {
            attemptCount: 2,
            inFlight: false,
            lastFailure: null,
            lastSucceededAt: '2026-05-20T00:00:30.000Z',
          },
          reset: {
            lastCompletedAt: null,
            lastDeletedPathCount: 0,
            lastError: null,
            lastFailedAt: null,
            lastPreservedPathCount: 0,
            lastStartedAt: null,
            status: 'idle',
            userDataPath: '/tmp/brainstrike-user-data',
          },
          telemetry: {
            backgroundRuntimeMetrics: [
              {
                cpuPercent: '1.0',
                idleWakeupsPerSecond: '0.0',
                osProcessId: 123,
                privateKb: '1000',
                runtimeKind: 'embedding-host',
                sharedKb: '200',
                workingSetKb: '1200',
              },
            ],
          },
        })),
      };

      render(<SystemDiagnosticsPanel />);

      expect(await screen.findByText('Desktop Platform')).toBeInTheDocument();
      expect(screen.getByText('Embedding Host')).toBeInTheDocument();
      expect(screen.getByText('LLM Host')).toBeInTheDocument();
      expect(screen.getByText('/tmp/brainstrike-user-data')).toBeInTheDocument();
      expect(screen.getByText('Active Backfills')).toBeInTheDocument();
      expect(screen.getByText('1 active')).toBeInTheDocument();
      expect(screen.getByText('Dimension Maintenance')).toBeInTheDocument();
      expect(screen.getByText('1 pending / 1 suspended')).toBeInTheDocument();
      expect(screen.getByText('Migration')).toBeInTheDocument();
      expect(screen.getByText('2 attempts')).toBeInTheDocument();
      expect(screen.getByText('Crash Recovery')).toBeInTheDocument();
      expect(screen.getByText('pending')).toBeInTheDocument();
      expect(screen.getByText('Runtime Metrics')).toBeInTheDocument();
      expect(screen.getByText('1 process')).toBeInTheDocument();
    });

    it('renders unsupported dimension maintenance diagnostics without reporting idle', async () => {
      (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
        getSnapshot: vi.fn(async () => ({
          collectedAt: '2026-05-20T00:00:00.000Z',
          crashRecovery: {
            lastRendererCrashReason: null,
            pendingRendererRecovery: false,
            rendererCrashCount: 0,
            rendererReloadAttemptCount: 0,
            suppressedRendererReloadCount: 0,
          },
          embeddingHost: {
            active: false,
            lastError: null,
            pendingRequestCount: 0,
            runtimeId: 'embedding-host:idle',
            runtimeKind: 'embedding-host',
            sourceState: 'running',
            state: 'idle',
          },
          llmHost: {
            active: false,
            lastError: null,
            pendingRequestCount: 0,
            runtimeId: 'llm-host:idle',
            runtimeKind: 'llm-host',
            sourceState: 'running',
            state: 'idle',
          },
          indexing: {
            activeBackfills: [],
            databaseWork: null,
            dimensionIndexMaintenance: {
              maintenance: [],
              reason: 'runtime-not-pglite',
              status: 'unsupported',
              suspensions: [],
            },
          },
          migration: {
            attemptCount: 0,
            inFlight: false,
            lastFailure: null,
            lastSucceededAt: null,
          },
          reset: {
            lastCompletedAt: null,
            lastDeletedPathCount: 0,
            lastError: null,
            lastFailedAt: null,
            lastPreservedPathCount: 0,
            lastStartedAt: null,
            status: 'idle',
            userDataPath: '/tmp/brainstrike-user-data',
          },
          telemetry: {
            backgroundRuntimeMetrics: [],
          },
        })),
      };

      render(<SystemDiagnosticsPanel />);

      expect(await screen.findByText('Dimension Maintenance')).toBeInTheDocument();
      expect(screen.getByText('unsupported')).toBeInTheDocument();
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

      return waitFor(() => {
        const queuePanel = screen.getByTestId('queue-diagnostics-panel');
        expect(queuePanel).toHaveAttribute('data-show-refresh', 'false');
      });
    });
  });
});

describe('createSystemDiagnosticsSettingsCategory', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    mockUseOptionalTokenCacheContext.mockReturnValue(null);
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
    vi.clearAllMocks();
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
    expect(category.content).toBeTruthy();
  });

  it('renders SystemDiagnosticsPanel when content is rendered', () => {
    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
  });

  it('reads token cache state from context when available', () => {
    // Mock the context to return operational token cache
    mockUseOptionalTokenCacheContext.mockReturnValue({
      isOperational: true,
      isPersisted: true,
      persistenceMode: 'persistent',
    });

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    // Verify the panel shows the correct status from context
    expect(screen.getByText('Fully Operational')).toBeInTheDocument();
    expect(screen.getByText('Token counts are saved to database')).toBeInTheDocument();
  });

  it('shows default state when context is not available', () => {
    // Mock the context to return null (no provider)
    mockUseOptionalTokenCacheContext.mockReturnValue(null);

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    // Verify the panel shows default "Not Ready" state
    expect(screen.getByText('Not Ready')).toBeInTheDocument();
    expect(screen.getByText('Token counting worker is not running')).toBeInTheDocument();
  });

  it('shows memory-only state when operational but not persisted', () => {
    mockUseOptionalTokenCacheContext.mockReturnValue({
      isOperational: true,
      isPersisted: false,
      persistenceMode: 'memory',
    });

    const category = createSystemDiagnosticsSettingsCategory();
    render(category.content);

    expect(screen.getByText('Memory Only')).toBeInTheDocument();
    expect(
      screen.getByText('Token counts are in-memory only (no persistence)')
    ).toBeInTheDocument();
  });
});
