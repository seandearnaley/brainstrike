/**
 * Tests for SystemDiagnosticsPanel (BST-181)
 */

import {
  __resetDatabaseStatusStoreForTests,
  useDatabaseStatusStore,
} from '@brainstrike/app-state/stores/database-status-store';
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rendererLongTaskTelemetry } from '../diagnostics/renderer-long-task-telemetry';
import { SystemDiagnosticsPanel } from '../diagnostics/system-diagnostics-panel';
import { createSystemDiagnosticsSettingsCategory } from '../diagnostics/system-diagnostics-settings-category';

// Mock the optional token cache context hook
const mockUseOptionalTokenCacheContext = vi.fn();
vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  useOptionalTokenCacheContext: () => mockUseOptionalTokenCacheContext(),
}));

describe('SystemDiagnosticsPanel', () => {
  beforeEach(() => {
    __resetDatabaseStatusStoreForTests();
    rendererLongTaskTelemetry.reset();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
  });

  afterEach(() => {
    __resetDatabaseStatusStoreForTests();
    rendererLongTaskTelemetry.reset();
    (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = undefined;
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('renders header with title and description', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('System Diagnostics')).toBeInTheDocument();
      expect(
        screen.getByText('Real-time health monitoring for database, indexing, and workers')
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

    it('surfaces renderer long-task aggregates in system diagnostics', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 125,
        enabledFeatureFlags: ['diagnostic-search'],
        route: 'settings',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Renderer Long Tasks')).toBeInTheDocument();
      expect(screen.getByText('Idle · 1 sample')).toBeInTheDocument();
      expect(screen.getAllByText('125 ms')).toHaveLength(3);
      expect(screen.getByText('Delivery-time routes')).toBeInTheDocument();
      expect(screen.getByText('Delivery-time feature flags')).toBeInTheDocument();
      expect(screen.getByText('settings (1)')).toBeInTheDocument();
      expect(screen.getByText('diagnostic-search (1)')).toBeInTheDocument();
    });

    it('updates renderer long-task diagnostics when the collector publishes', () => {
      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('No feature flag source')).toBeInTheDocument();

      act(() => {
        rendererLongTaskTelemetry.record({
          durationMs: 80,
          enabledFeatureFlags: null,
          route: 'explorer',
        });
      });

      expect(screen.getByText('Idle · 1 sample')).toBeInTheDocument();
      expect(screen.getAllByText('80 ms')).toHaveLength(3);
      expect(screen.getByText('Unavailable for retained samples')).toBeInTheDocument();
    });

    it('does not treat retained samples with unknown flag context as no flags active', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: null,
        route: 'explorer',
      });
      rendererLongTaskTelemetry.updateContext({
        enabledFeatureFlags: ['diagnostics-v2'],
        route: 'explorer',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'Unavailable for retained samples'
      );
      act(() => {
        rendererLongTaskTelemetry.record({
          durationMs: 90,
          enabledFeatureFlags: ['diagnostics-v2'],
          route: 'explorer',
        });
      });
      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'diagnostics-v2 (1) · partial context, 1 of 2 samples'
      );
    });

    it('shows the known-context denominator when mixed samples have no active flags', () => {
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: null,
        route: 'explorer',
      });
      rendererLongTaskTelemetry.record({
        durationMs: 90,
        enabledFeatureFlags: [],
        route: 'explorer',
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'Partial feature flag context, 1 of 2 samples'
      );
    });

    it('labels unsupported long-task collection instead of reporting zero samples', () => {
      vi.stubGlobal('PerformanceObserver', undefined);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Unsupported')).toBeInTheDocument();
      expect(
        screen.getByText('PerformanceObserver is unavailable in this renderer.')
      ).toBeInTheDocument();
    });

    it('keeps the retained sample count visible when observation fails', () => {
      class ThrowingPerformanceObserver {
        static readonly supportedEntryTypes = ['longtask'];

        constructor(_callback: PerformanceObserverCallback) {
          throw new Error('observer construction failed');
        }
      }
      rendererLongTaskTelemetry.record({
        durationMs: 80,
        enabledFeatureFlags: [],
        route: 'settings',
      });
      vi.stubGlobal('PerformanceObserver', ThrowingPerformanceObserver);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Failed · 1 sample')).toBeInTheDocument();
      expect(screen.getByText('observer construction failed')).toBeInTheDocument();
    });

    it('distinguishes no samples from no active feature flags', () => {
      class MockPerformanceObserver {
        static readonly supportedEntryTypes = ['longtask'];

        observe(): void {}

        disconnect(): void {}
      }
      vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
      act(() => {
        rendererLongTaskTelemetry.observe(() => ({
          enabledFeatureFlags: [],
          route: 'settings',
        }));
      });

      render(<SystemDiagnosticsPanel />);

      expect(screen.getByText('Delivery-time feature flags').parentElement).toHaveTextContent(
        'No samples'
      );
    });

    it('renders desktop platform diagnostics when the desktop bridge is available', async () => {
      (window as Window & { desktopDiagnostics?: unknown }).desktopDiagnostics = {
        getSnapshot: vi.fn(async () => ({
          ok: true,
          value: {
            collectedAt: '2026-05-20T00:00:00.000Z',
            crashRecovery: {
              lastRendererCrashAt: '2026-05-20T00:01:00.000Z',
              lastRendererCrashExitCode: 5,
              lastRendererCrashReason: 'crashed',
              lastRendererReloadAt: null,
              pendingRendererRecovery: true,
              rendererCrashCount: 1,
              rendererReloadAttemptCount: 0,
              suppressedRendererReloadCount: 0,
            },
            indexing: {
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
          },
        })),
      };

      render(<SystemDiagnosticsPanel />);

      expect(await screen.findByText('Desktop Platform')).toBeInTheDocument();
      expect(screen.getByText('/tmp/brainstrike-user-data')).toBeInTheDocument();
      // Desktop has no backfill queue; native indexing reports its own activity.
      expect(screen.queryByText('Active Backfills')).not.toBeInTheDocument();
      expect(screen.getByText('Dimension Maintenance')).toBeInTheDocument();
      expect(screen.getByText('1 pending / 1 suspended')).toBeInTheDocument();
      expect(screen.getByText('Migration')).toBeInTheDocument();
      expect(screen.getByText('2 attempts')).toBeInTheDocument();
      expect(screen.getByText('Crash Recovery')).toBeInTheDocument();
      expect(screen.getByText('pending')).toBeInTheDocument();
    });
    it('shows a typed diagnostic refusal and its remedy after transport', async () => {
      Object.assign(window, {
        desktopDiagnostics: {
          getSnapshot: async () => ({
            error: {
              category: 'availability',
              code: 'diagnostics.unavailable',
              kind: 'refusal',
              message: 'Diagnostics are unavailable.',
              remedy: 'Refresh after reconnecting.',
            },
            ok: false,
          }),
        },
      });
      render(<SystemDiagnosticsPanel />);
      expect(
        await screen.findByText('Diagnostics are unavailable. Refresh after reconnecting.')
      ).toBeVisible();
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
    expect(category.description).toBe(
      'Monitor database, indexing, and worker health in real-time.'
    );
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
